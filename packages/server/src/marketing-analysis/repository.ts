import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { ANALYSIS_VERSION, type AnalysisLease, type AnalysisSnapshot, type AnalysisJobStore, type ReferenceAnalysis, type ScreenText } from "@lot-agent/core/marketing-analysis";
import { SecretBox } from "../auth/secret-box.js";
import { parseAnalysisSource } from "./source.js";
import { AnalysisError } from "./errors.js";
import { ANALYSIS_JOB, ANALYSIS_QUEUE, type AnalysisConfig } from "./config.js";

export function analysisRecord(row: Record<string, any>): ReferenceAnalysis {
  return { id: row.id, ownerId: row.user_id, taskId: row.id, revision: row.revision, version: row.version,
    status: row.status, stage: row.stage, errorCode: row.error_code ?? undefined, snapshot: row.snapshot,
    projectId: row.creation_context?.projectId, applied: row.creation_context?.applied === true,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
export async function ownerLock(client: pg.PoolClient, owner: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`media-analysis-budget:${owner}`]);
}
export class PgAnalysisStore implements AnalysisJobStore {
  constructor(readonly pool: pg.Pool, readonly secrets = new SecretBox(process.env.SECRET_MASTER_KEY),
    private readonly capacity?: (owner: string, pending: number, globalPending: number) => Promise<void>) {}
  async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await operation(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async row(owner: string, id: string, client: Pick<pg.PoolClient, "query"> = this.pool, lock = false) {
    const row = (await client.query(`SELECT * FROM marketing_reference_analyses WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [owner, id])).rows[0];
    if (!row) throw new AnalysisError("ANALYSIS_NOT_FOUND", 404);
    return row;
  }
  async get(owner: string, id: string) {
    try { return analysisRecord(await this.row(owner, id)); } catch (error) { if (error instanceof AnalysisError && error.status === 404) return null; throw error; }
  }
  async list(owner: string, offset = 0) {
    return (await this.pool.query(`SELECT id,user_id,revision,version,status,stage,error_code,created_at,updated_at,creation_context,
      jsonb_build_object('source',snapshot->'source','frames','[]'::jsonb,'frameTexts','[]'::jsonb,'texts','[]'::jsonb,'observations','[]'::jsonb) AS snapshot
      FROM marketing_reference_analyses WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 20 OFFSET $2`, [owner, offset])).rows.map(analysisRecord);
  }
  private async admit(client: pg.PoolClient, owner: string) {
    const pending = (await client.query("SELECT count(*) AS count FROM marketing_reference_analyses WHERE user_id=$1 AND status IN ('queued','running') AND deleted_at IS NULL", [owner])).rows[0];
    if (this.capacity) {
      // Serialize disk reservations across owners as well as per-owner admission.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('media-analysis-storage',0))");
      const reserved = (await client.query(`SELECT count(*) AS global_count,count(*) FILTER(WHERE user_id=$1) AS owner_count
        FROM marketing_reference_analyses WHERE (status IN ('queued','running') OR lease_until>now()) AND deleted_at IS NULL`, [owner])).rows[0];
      await this.capacity(owner, Number(reserved.owner_count), Number(reserved.global_count));
    }
    if (Number(pending.count) >= 3) throw new AnalysisError("ANALYSIS_CONCURRENCY_LIMIT", 409);
  }
  async create(owner: string, input: { shareText: string; clientRequestId: string; target?: { projectId: string; projectVersion: number; locale: "zh" | "en" | "id" } }, _config: AnalysisConfig) {
    const source = parseAnalysisSource(input.shareText);
    const hash = createHash("sha256").update(input.target ? JSON.stringify([source.canonicalUrl, input.target.projectId, input.target.projectVersion, input.target.locale]) : source.canonicalUrl).digest("hex");
    return this.transaction(async client => {
      await ownerLock(client, owner);
      const existing = (await client.query("SELECT * FROM marketing_reference_analyses WHERE user_id=$1 AND client_request_id=$2", [owner, input.clientRequestId])).rows[0];
      if (existing) {
        if (existing.input_hash !== hash || existing.deleted_at) throw new AnalysisError("REQUEST_CONFLICT", 409);
        return analysisRecord(existing);
      }
      if (!this.secrets.enabled) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
      let context = null;
      if (input.target) {
        const project = (await client.query("SELECT * FROM marketing_video_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", [input.target.projectId, owner])).rows[0];
        if (!project) throw new AnalysisError("PROJECT_NOT_FOUND", 404);
        if (project.version !== input.target.projectVersion || project.task_id) throw new AnalysisError("PROJECT_CONFLICT", 409);
        const draft = MarketingDraftSchema.parse(project.draft);
        if (draft.copyMode !== "rewrite" || draft.reference.trim() !== input.shareText.trim()) throw new AnalysisError("PROJECT_CONFLICT", 409);
        context = { ...input.target, projectVersion: project.version + 1, draft };
      }
      await this.admit(client, owner);
      const id = randomUUID(); const sourceId = randomUUID();
      const snapshot: AnalysisSnapshot = { source, frames: [], frameTexts: [], texts: [], observations: [] };
      await client.query("INSERT INTO marketing_reference_sources(id,user_id,share_text,platform) VALUES($1,$2,$3,$4)", [sourceId, owner, this.secrets.seal(input.shareText), source.platform]);
      await client.query("INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,$2,$3,$4,$5)", [id, ANALYSIS_JOB, JSON.stringify({ analysisId: id }), owner, ANALYSIS_QUEUE]);
      const row = (await client.query(`INSERT INTO marketing_reference_analyses(id,user_id,source_id,client_request_id,input_hash,pipeline_version,snapshot,creation_context)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, owner, sourceId, input.clientRequestId, hash, ANALYSIS_VERSION, JSON.stringify(snapshot), context ? JSON.stringify(context) : null])).rows[0];
      if (context) await client.query(`UPDATE marketing_video_projects SET reference_analysis_id=$3,reference_revision=0,
        reference_evidence_ids='[]'::jsonb,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2`, [context.projectId, owner, id]);
      return analysisRecord(row);
    });
  }
  async claim(id: string): Promise<AnalysisLease | null> {
    return this.transaction(async client => {
      const owner = (await client.query("SELECT user_id FROM marketing_reference_analyses WHERE id=$1 AND deleted_at IS NULL", [id])).rows[0]?.user_id;
      if (!owner) return null;
      await ownerLock(client, owner);
      const row = await this.row(owner, id, client, true);
      if (!["queued", "running"].includes(row.status) || row.cancel_requested || (row.lease_until && new Date(row.lease_until).getTime() > Date.now())) return null;
      if ((await client.query("SELECT 1 FROM marketing_reference_analyses WHERE user_id=$1 AND id<>$2 AND status='running' AND lease_until>now()", [owner, id])).rowCount) return null;
      const token = randomUUID();
      await client.query("UPDATE marketing_reference_analyses SET status='running',lease_token=$2,lease_until=now()+interval '90 seconds',updated_at=now() WHERE id=$1", [id, token]);
      await client.query("UPDATE tasks SET status='running',attempts=attempts+1,updated_at=now() WHERE id=$1", [id]);
      return { id, ownerId: owner, token, revision: row.revision };
    });
  }
  async leased(client: Pick<pg.PoolClient, "query">, lease: AnalysisLease, allowCancelled = false) {
    const row = await this.row(lease.ownerId, lease.id, client, true);
    if (row.lease_token !== lease.token || row.revision !== lease.revision || new Date(row.lease_until).getTime() <= Date.now()
      || (!allowCancelled && (row.status !== "running" || row.cancel_requested))) throw new AnalysisError("ANALYSIS_LEASE_LOST", 409);
    return row;
  }
  async heartbeat(lease: AnalysisLease) {
    return !!(await this.pool.query(`UPDATE marketing_reference_analyses SET lease_until=now()+interval '90 seconds'
      WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND lease_until>now() AND status='running' AND NOT cancel_requested AND deleted_at IS NULL`, [lease.id, lease.ownerId, lease.token])).rowCount;
  }
  async checkpoint(lease: AnalysisLease, snapshot: AnalysisSnapshot, stage: string, selection?: unknown) {
    await this.transaction(async client => {
      await this.leased(client, lease);
      await client.query(`UPDATE marketing_reference_analyses SET snapshot=$4,stage=$5,selection=COALESCE($6,selection),version=version+1,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND lease_token=$3`, [lease.id, lease.ownerId, lease.token, JSON.stringify(snapshot), stage, selection ? JSON.stringify(selection) : null]);
      await client.query("UPDATE tasks SET stage=$2,updated_at=now() WHERE id=$1", [lease.id, stage]);
    });
  }
  async sourceText(lease: AnalysisLease) {
    const row = await this.row(lease.ownerId, lease.id);
    const source = (await this.pool.query("SELECT share_text FROM marketing_reference_sources WHERE id=$1 AND user_id=$2", [row.source_id, lease.ownerId])).rows[0];
    return this.secrets.open(source.share_text);
  }
  async finish(lease: AnalysisLease, errorCode?: string) {
    return this.transaction(async client => {
      await ownerLock(client, lease.ownerId);
      const row = await this.leased(client, lease, true);
      const pending = await client.query(`SELECT 1 FROM marketing_analysis_steps WHERE analysis_id=$1 AND user_id=$2
        AND (receipt IS NULL OR receipt->>'outcome'='request_unknown' OR (receipt->'usage' IS NULL AND receipt->>'outcome'<>'rejected'))`, [lease.id, lease.ownerId]);
      const unknown = !!pending.rowCount;
      const cancelled = row.cancel_requested;
      let code = unknown ? "REQUEST_UNKNOWN" : errorCode;
      const context = row.creation_context;
      if (!cancelled && !code && context && !context.applied) {
        const project = (await client.query("SELECT * FROM marketing_video_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", [context.projectId, lease.ownerId])).rows[0];
        if (!project || project.version !== context.projectVersion || project.task_id || project.reference_analysis_id !== row.id) code = "PROJECT_CONFLICT";
        else if (!row.snapshot.creation) code = "CREATION_REQUIRED";
        else {
          const draft = MarketingDraftSchema.parse(row.snapshot.creation.draft);
          await client.query(`UPDATE marketing_video_projects SET draft=$3,version=version+1,review=NULL,reviewed_script=NULL,
            reference_revision=$4,reference_evidence_ids=$5,updated_at=now() WHERE id=$1 AND user_id=$2`,
          [context.projectId, lease.ownerId, JSON.stringify(draft), row.revision, JSON.stringify([...row.snapshot.texts.map((t: ScreenText) => t.id), ...row.snapshot.frames.map((f: { id: string }) => f.id)])]);
          await client.query("UPDATE marketing_reference_analyses SET creation_context=creation_context || '{\"applied\":true}'::jsonb WHERE id=$1", [row.id]);
        }
      }
      const status = cancelled ? "cancelled" : unknown ? "needs_review" : !code ? "ready" : ["AUTH_REQUIRED", "CHALLENGE_REQUIRED"].includes(code) ? "needs_auth" : row.snapshot.texts.length ? "partial" : "failed";
      const reserved = 0;
      await client.query("UPDATE marketing_reference_analyses SET status=$2,error_code=$3,reserved_cost=$4,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1", [lease.id, status, code ?? null, reserved]);
      await client.query("UPDATE tasks SET status=$2,error=$3,progress=$4,updated_at=now() WHERE id=$1", [lease.id, status === "ready" ? "succeeded" : cancelled ? "cancelled" : "failed", code ?? null, status === "ready" ? 100 : 0]);
      await client.query("INSERT INTO marketing_analysis_revisions(analysis_id,revision,snapshot) VALUES($1,$2,$3) ON CONFLICT(analysis_id,revision) DO UPDATE SET snapshot=excluded.snapshot", [lease.id, row.revision, JSON.stringify(row.snapshot)]);
    });
  }
  async cancel(owner: string, id: string) {
    await this.transaction(async client => {
      await ownerLock(client, owner); const row = await this.row(owner, id, client, true);
      if (!["queued", "running"].includes(row.status)) return;
      await client.query("UPDATE marketing_reference_analyses SET status='cancelled',cancel_requested=true,reserved_cost=CASE WHEN lease_token IS NULL THEN 0 ELSE reserved_cost END,version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1", [id]);
    });
    return this.get(owner, id);
  }
  async resume(owner: string, id: string, revision: number, summarizeOnly = false) {
    await this.transaction(async client => {
      await ownerLock(client, owner); const row = await this.row(owner, id, client, true);
      if (row.revision !== revision) throw new AnalysisError("REVISION_CONFLICT", 409);
      if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new AnalysisError("ANALYSIS_BUSY", 409);
      if ((await client.query(`SELECT 1 FROM marketing_analysis_steps WHERE analysis_id=$1 AND (receipt IS NULL OR receipt->>'outcome'='request_unknown' OR (receipt->'usage' IS NULL AND receipt->>'outcome'<>'rejected'))`, [id])).rowCount) throw new AnalysisError("REQUEST_UNKNOWN", 409);
      if (row.status === "queued") return;
      if (summarizeOnly && !row.snapshot.frames.length) throw new AnalysisError("EVIDENCE_REQUIRED", 409);
      if (!summarizeOnly && row.status === "ready") return;
      await this.admit(client, owner);
      // Malformed OCR is already a recorded coverage gap, not unfinished work.
      // Also clear flags left by older resume logic. Rejected OCR is retryable
      // after replenishing upstream credit; unknown requests stay blocked above.
      await client.query(`UPDATE marketing_analysis_steps SET retry_requested=
        (receipt->>'outcome'='rejected' OR step_id NOT LIKE 'ocr:%')
        WHERE analysis_id=$1 AND ((receipt->>'outcome'='failed' AND receipt->'usage' IS NOT NULL) OR receipt->>'outcome'='rejected')`, [id]);
      await client.query(`UPDATE marketing_reference_analyses SET status='queued',mode=$2,reserved_cost=$3,cancel_requested=false,
        lease_token=NULL,lease_until=NULL,error_code=NULL,scratch_cleaned_at=NULL,version=version+1,updated_at=now() WHERE id=$1`, [id, summarizeOnly || row.revision > 1 ? "summary" : "all", 0]);
      await client.query("UPDATE tasks SET status='pending',error=NULL,updated_at=now() WHERE id=$1", [id]);
    });
    return this.get(owner, id);
  }
  async edit(owner: string, id: string, revision: number, changes: Pick<ScreenText, "id" | "text">[]) {
    await this.transaction(async client => {
      const row = await this.row(owner, id, client, true);
      if (row.revision !== revision) throw new AnalysisError("REVISION_CONFLICT", 409);
      if (["queued", "running"].includes(row.status) || (row.lease_until && new Date(row.lease_until).getTime() > Date.now())) throw new AnalysisError("ANALYSIS_BUSY", 409);
      const texts: ScreenText[] = row.snapshot.texts;
      if (new Set(changes.map(t => t.id)).size !== changes.length || changes.some(t => !texts.some(old => old.id === t.id))) throw new AnalysisError("INVALID_TEXT_REFERENCE");
      await client.query("INSERT INTO marketing_analysis_revisions(analysis_id,revision,snapshot) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id, revision, JSON.stringify(row.snapshot)]);
      const snapshot: AnalysisSnapshot = { ...row.snapshot, texts: texts.map(t => ({ ...t, text: changes.find(change => change.id === t.id)?.text ?? t.text })) };
      delete snapshot.summary; delete snapshot.summaryRevision; delete snapshot.creation;
      await client.query("UPDATE marketing_reference_analyses SET snapshot=$2,revision=revision+1,version=version+1,status='partial',error_code=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(snapshot)]);
    });
    return this.get(owner, id);
  }
  async remove(owner: string, id: string) {
    await this.transaction(async client => {
      await ownerLock(client, owner); const row = await this.row(owner, id, client, true);
      if (["queued", "running"].includes(row.status) || (row.lease_until && new Date(row.lease_until).getTime() > Date.now())) throw new AnalysisError("ANALYSIS_BUSY", 409);
      if ((await client.query("SELECT 1 FROM marketing_analysis_steps WHERE analysis_id=$1 AND (receipt IS NULL OR receipt->>'outcome'='request_unknown' OR (receipt->'usage' IS NULL AND receipt->>'outcome'<>'rejected'))", [id])).rowCount) throw new AnalysisError("REQUEST_UNKNOWN", 409);
      if ((await client.query("SELECT 1 FROM marketing_video_projects WHERE reference_analysis_id=$1", [id])).rowCount) throw new AnalysisError("ANALYSIS_IN_USE", 409);
      await client.query("UPDATE marketing_reference_analyses SET deleted_at=now(),snapshot='{}'::jsonb,selection=NULL,creation_context=NULL WHERE id=$1", [id]);
      await client.query("UPDATE marketing_reference_sources SET share_text='' WHERE id=$1", [row.source_id]);
      await client.query("DELETE FROM marketing_analysis_revisions WHERE analysis_id=$1", [id]);
      await client.query(`UPDATE marketing_analysis_steps SET receipt=receipt-'text',
        reconciliation=(reconciliation-'note') #- '{previousReceipt,text}' WHERE analysis_id=$1`, [id]);
    });
  }
}
