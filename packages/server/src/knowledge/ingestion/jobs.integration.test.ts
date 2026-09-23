import { afterAll, beforeAll, expect, it, describe, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { KnowledgeRepository } from "../repository.js";
import { KnowledgeJobs } from "./jobs.js";
import { dispatchKnowledgeOutbox } from "./outbox.js";
import { runMigrations } from "../../db/migration-runner.js";
import { migrations } from "../../db/migrations/index.js";

describe.skipIf(process.env.RAG_INTEGRATION !== "1")("persistent knowledge ingestion", () => {
  let pool: pg.Pool; let repo: KnowledgeRepository; let jobs: KnowledgeJobs;
  const owner = randomUUID(); const queueName = `lot-knowledge-test-${randomUUID()}`;
  let seeded = false;
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1", "::1"].includes(process.env.PG_HOST ?? "localhost")) throw new Error("Local database only");
    pool = new pg.Pool({ host: process.env.PG_HOST ?? "localhost", port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(pool, migrations);
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'rag jobs integration')", [owner]); seeded = true;
    repo = new KnowledgeRepository(pool, queueName); jobs = new KnowledgeJobs(pool);
  });
  afterAll(async () => {
    try { if (seeded) { await pool.query("DELETE FROM tasks WHERE user_id=$1", [owner]); await pool.query("DELETE FROM users WHERE id=$1", [owner]); } }
    finally { await pool?.end(); }
  });
  const create = () => repo.createItem(owner, { sourceType: "note", title: "测试", content: "测试正文", description: "", tags: [], collectionIds: [] }, randomUUID());
  it("commits task/run/outbox together and rolls everything back if preparation fails", async () => {
    const item = await create();
    expect(item.taskId).toBeTruthy();
    const result = await pool.query("SELECT o.task_id,t.queue_name FROM rag_outbox o JOIN tasks t ON t.id=o.task_id WHERE t.id=$1", [item.taskId]);
    expect(result.rows).toEqual([{ task_id: item.taskId, queue_name: queueName }]);
    const bad = new KnowledgeRepository(pool, "lot-tasks");
    await expect(bad.createItem(owner, { sourceType: "note", title: "rollback fixture", content: "test", description: "", tags: [], collectionIds: [] }, randomUUID())).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int AS n FROM rag_items WHERE owner_id=$1 AND title='rollback fixture'", [owner])).rows[0].n).toBe(0);
  });
  it("keeps a failed delivery pending and reuses the same ID across the send/ack gap", async () => {
    const ids: string[] = [];
    await dispatchKnowledgeOutbox(pool, queueName, async () => { throw new Error("redis down secret"); });
    const pending = await pool.query("SELECT task_id,last_error_code FROM rag_outbox WHERE queue_name=$1 AND delivered_at IS NULL", [queueName]);
    expect(pending.rows.length).toBeGreaterThan(0); expect(pending.rows[0].last_error_code).toBe("QUEUE_UNAVAILABLE");
    await pool.query("UPDATE rag_outbox SET available_at=now() WHERE queue_name=$1", [queueName]);
    await dispatchKnowledgeOutbox(pool, queueName, async (id) => { ids.push(id); });
    await pool.query("UPDATE rag_outbox SET available_at=now(),delivered_at=NULL WHERE queue_name=$1", [queueName]);
    await dispatchKnowledgeOutbox(pool, queueName, async (id) => { ids.push(id); });
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  });
  it("rejects wrong queues and duplicate claims, and fences a worker after lease expiry", async () => {
    const item = await create();
    expect(await jobs.claim(item.taskId!, "lot-tasks")).toBeNull();
    const first = await jobs.claim(item.taskId!, queueName); expect(first).not.toBeNull();
    expect(await jobs.claim(item.taskId!, queueName)).toBeNull();
    await pool.query("UPDATE rag_ingestion_runs SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1", [item.taskId]);
    const next = await jobs.claim(item.taskId!, queueName); expect(next?.token).not.toBe(first?.token);
    const writer = vi.fn(async () => {});
    expect(await jobs.publish(first!, writer)).toBe(false); expect(writer).not.toHaveBeenCalled();
    expect(await jobs.publish(next!, writer)).toBe(true);
    expect(await jobs.publish(next!, writer)).toBe(false); expect(writer).toHaveBeenCalledTimes(1);
  });
  it("does not publish or resurrect a cancelled/deleted/superseded revision", async () => {
    for (const action of ["cancel", "delete", "replace"]) {
      const item = await create(); const lease = await jobs.claim(item.taskId!, queueName);
      if (action === "cancel") expect(await new KnowledgeJobs(pool).cancel(owner, item.taskId!)).toBe(true);
      if (action === "delete") await repo.deleteItem(owner, item.id, 1);
      if (action === "replace") await repo.updateItem(owner, item.id, { version: 1, title: "新版本", content: "新正文", description: "", tags: [] });
      expect(await jobs.heartbeat(lease!, "late", 99)).toBe(false);
      expect(await jobs.publish(lease!, async () => { throw new Error("must not write"); })).toBe(false);
      expect(await jobs.fail(lease!, "LATE_ERROR", false)).toBe(false);
    }
  });
  it("retains a usable old version when replacement fails and retries with a new generation", async () => {
    const item = await create(); const old = await jobs.claim(item.taskId!, queueName); await jobs.publish(old!, async () => {});
    const update = await repo.updateItem(owner, item.id, { version: 1, title: "新", content: "新正文", description: "", tags: [] });
    const current = await jobs.claim(update.taskId!, queueName); await jobs.fail(current!, "EMBEDDING_UNAVAILABLE", false);
    expect((await repo.getItem(owner, item.id)).activeRevisionId).toBe(item.revisionId);
    const retry = await jobs.retry(owner, item.id, 2, queueName); expect(retry.taskId).not.toBe(update.taskId);
    expect((await jobs.claim(retry.taskId, queueName))?.generation).toBe(3);
  });
  it("rolls back index writes and state on publisher failure; persisted cancellation remains final", async () => {
    const item = await create(); const lease = await jobs.claim(item.taskId!, queueName);
    await expect(jobs.publish(lease!, async (client) => {
      await client.query("UPDATE rag_items SET title='must rollback' WHERE id=$1", [item.id]); throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect((await repo.getItem(owner, item.id)).title).toBe("测试");
    await expect(jobs.cancel(randomUUID(), item.taskId!)).rejects.toMatchObject({ status: 404 });
    expect(await jobs.cancel(owner, item.taskId!)).toBe(true);
  });
});
