import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { KnowledgeError } from "../errors.js";
import { prepareIngestion } from "./prepare.js";

export interface IngestionLease { taskId: string; ownerId: string; itemId: string; revisionId: string; generation: number; token: string; attempts: number }

export class KnowledgeJobs {
  constructor(readonly pool: Pool, readonly leaseSeconds = 90) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 600) throw new Error("Invalid lease duration");
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** Lock order is always item → task → run, including cancel and publish. */
  private async lock(client: PoolClient, taskId: string) {
    const found = await client.query("SELECT item_id,owner_id FROM rag_ingestion_runs WHERE task_id=$1", [taskId]);
    if (!found.rows[0]) return null;
    const { item_id, owner_id } = found.rows[0];
    const item = await client.query("SELECT * FROM rag_items WHERE id=$1 AND owner_id=$2 FOR UPDATE", [item_id, owner_id]);
    if (!item.rows[0]) return null;
    const task = await client.query("SELECT status,queue_name FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE", [taskId, owner_id]);
    const run = await client.query("SELECT *,lease_expires_at>now() AS leased FROM rag_ingestion_runs WHERE task_id=$1 FOR UPDATE", [taskId]);
    if (!task.rows[0] || !run.rows[0]) return null;
    return { item: item.rows[0], task: task.rows[0], run: run.rows[0] };
  }
  private current(state: NonNullable<Awaited<ReturnType<KnowledgeJobs["lock"]>>>) {
    return !state.item.deleted_at && state.item.pending_revision_id === state.run.revision_id
      && state.item.generation === state.run.generation && ["pending", "running"].includes(state.task.status)
      && ["pending", "running"].includes(state.run.status);
  }
  async claim(taskId: string, queueName: string): Promise<IngestionLease | null> {
    return this.transaction(async (client) => {
      const state = await this.lock(client, taskId);
      if (!state || state.task.queue_name !== queueName || !this.current(state) || state.run.leased) return null;
      const token = randomUUID(); const attempts = state.run.attempts + 1;
      await client.query("UPDATE rag_ingestion_runs SET status='running',attempts=$2,lease_token=$3,lease_expires_at=now()+make_interval(secs=>$4),updated_at=now() WHERE task_id=$1", [taskId, attempts, token, this.leaseSeconds]);
      await client.query("UPDATE tasks SET status='running',attempts=$2,stage='preparing',error=NULL,updated_at=now() WHERE id=$1", [taskId, attempts]);
      await client.query("UPDATE rag_item_revisions SET index_status='processing' WHERE owner_id=$1 AND item_id=$2 AND id=$3", [state.run.owner_id, state.run.item_id, state.run.revision_id]);
      return { taskId, ownerId: state.run.owner_id, itemId: state.run.item_id, revisionId: state.run.revision_id, generation: state.run.generation, token, attempts };
    });
  }
  async heartbeat(lease: IngestionLease, stage?: string, progress?: number): Promise<boolean> {
    return this.transaction(async (client) => {
      const state = await this.lock(client, lease.taskId);
      if (!state || !this.current(state) || !state.run.leased || state.run.lease_token !== lease.token) return false;
      await client.query("UPDATE rag_ingestion_runs SET lease_expires_at=now()+make_interval(secs=>$2),updated_at=now() WHERE task_id=$1", [lease.taskId, this.leaseSeconds]);
      await client.query("UPDATE tasks SET stage=COALESCE($2,stage),progress=COALESCE($3,progress),updated_at=now() WHERE id=$1", [lease.taskId, stage ?? null, progress === undefined ? null : Math.min(99, Math.max(0, progress))]);
      return true;
    });
  }
  async checkpoint(lease: IngestionLease, version: string, artifact: unknown): Promise<boolean> {
    return this.transaction(async (client) => {
      const state = await this.lock(client, lease.taskId);
      if (!state || !this.current(state) || !state.run.leased || state.run.lease_token !== lease.token) return false;
      await client.query("UPDATE rag_ingestion_runs SET artifact=$2,artifact_version=$3,updated_at=now() WHERE task_id=$1", [lease.taskId, JSON.stringify(artifact), version]);
      return true;
    });
  }
  async readCheckpoint(lease: IngestionLease, version: string): Promise<unknown | null> {
    const { rows } = await this.pool.query("SELECT artifact FROM rag_ingestion_runs WHERE task_id=$1 AND owner_id=$2 AND artifact_version=$3", [lease.taskId, lease.ownerId, version]);
    return rows[0]?.artifact ?? null;
  }
  /** The index writer must validate chunk/vector completeness, and only use this transaction. */
  async publish(lease: IngestionLease, writeIndex: (client: PoolClient) => Promise<void>): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`index-owner:${lease.ownerId}`]);
      const state = await this.lock(client, lease.taskId);
      if (!state || !this.current(state) || !state.run.leased || state.run.lease_token !== lease.token) return false;
      await writeIndex(client);
      await client.query("UPDATE rag_item_revisions SET index_status='ready' WHERE owner_id=$1 AND item_id=$2 AND id=$3", [lease.ownerId, lease.itemId, lease.revisionId]);
      await client.query("UPDATE rag_items SET active_revision_id=$3,pending_revision_id=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2", [lease.ownerId, lease.itemId, lease.revisionId]);
      await client.query("UPDATE tasks SET status='succeeded',progress=100,stage='ready',output=$2,updated_at=now() WHERE id=$1", [lease.taskId, JSON.stringify({ itemId: lease.itemId, revisionId: lease.revisionId })]);
      await client.query("UPDATE rag_ingestion_runs SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE task_id=$1", [lease.taskId]);
      return true;
    });
  }
  async fail(lease: IngestionLease, code: string, retry: boolean): Promise<boolean> {
    if (!/^[A-Z_]{1,64}$/.test(code)) throw new Error("Only sanitized error codes may be persisted");
    return this.transaction(async (client) => {
      const state = await this.lock(client, lease.taskId);
      if (!state || !this.current(state) || !state.run.leased || state.run.lease_token !== lease.token) return false;
      await client.query("UPDATE rag_ingestion_runs SET status=$2,error_code=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE task_id=$1", [lease.taskId, retry ? "pending" : "failed", code]);
      await client.query("UPDATE tasks SET status=$2,error=$3,stage=$4,updated_at=now() WHERE id=$1", [lease.taskId, retry ? "pending" : "failed", code, retry ? "retrying" : "failed"]);
      await client.query("UPDATE rag_item_revisions SET index_status=$4 WHERE owner_id=$1 AND item_id=$2 AND id=$3", [lease.ownerId, lease.itemId, lease.revisionId, retry ? "pending" : "failed"]);
      return true;
    });
  }
  async cancel(owner: string, taskId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const state = await this.lock(client, taskId);
      if (!state || state.run.owner_id !== owner) throw new KnowledgeError("NOT_FOUND", 404, "任务不存在");
      if (!this.current(state)) return false;
      await client.query("UPDATE rag_items SET generation=generation+1,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [owner, state.run.item_id]);
      await client.query("UPDATE rag_item_revisions SET index_status='cancelled' WHERE owner_id=$1 AND item_id=$2 AND id=$3", [owner, state.run.item_id, state.run.revision_id]);
      await client.query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1", [taskId]);
      await client.query("UPDATE rag_ingestion_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE task_id=$1", [taskId]);
      return true;
    });
  }
  async retry(owner: string, itemId: string, version: number, queueName: string) {
    return this.transaction(async (client) => {
      const item = await client.query("SELECT * FROM rag_items WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [owner, itemId]);
      const row = item.rows[0];
      if (!row) throw new KnowledgeError("NOT_FOUND", 404, "资料不存在");
      if (row.version !== version) throw new KnowledgeError("CONFLICT", 409, "资料已更新");
      const revision = await client.query("SELECT index_status FROM rag_item_revisions WHERE owner_id=$1 AND item_id=$2 AND id=$3", [owner, itemId, row.pending_revision_id]);
      if (!revision.rows[0] || !["failed", "cancelled", "pending"].includes(revision.rows[0].index_status)) throw new KnowledgeError("CONFLICT", 409, "当前资料不能重试");
      const live = await client.query("SELECT task_id FROM rag_ingestion_runs WHERE owner_id=$1 AND revision_id=$2 AND status IN ('pending','running')", [owner, row.pending_revision_id]);
      if (live.rows[0]) return { taskId: live.rows[0].task_id, version };
      const generation = row.generation + 1;
      await client.query("UPDATE rag_items SET generation=$3,version=version+1 WHERE owner_id=$1 AND id=$2", [owner, itemId, generation]);
      await client.query("UPDATE rag_item_revisions SET generation=$4,index_status='pending' WHERE owner_id=$1 AND item_id=$2 AND id=$3", [owner, itemId, row.pending_revision_id, generation]);
      const taskId = await prepareIngestion(client, { ownerId: owner, itemId, revisionId: row.pending_revision_id, generation, queueName });
      return { taskId, version: version + 1 };
    });
  }
}
