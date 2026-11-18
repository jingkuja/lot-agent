import { loadRepoEnv } from "../env-file.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { agentRunState } from "../db/migrations/0034-agent-run-state.js";
import { RunRepository } from "./run-repository.js";
import { DB } from "../db/database.js";

/** Isolated local schema only; never migrates or modifies business tables. */
describe.skipIf(process.env.REACT_PG_TEST !== "1")("durable ReAct state on PostgreSQL", () => {
  const schema = `codex_react_test_${randomUUID().replaceAll("-", "")}`;
  const conversationId = randomUUID();
  const firstRun = randomUUID();
  const sourceMessageId = randomUUID();
  let pool: pg.Pool;
  let repository: RunRepository;
  let db: DB;
  let schemaCreated = false;
  beforeAll(async () => {
    const localEnv: NodeJS.ProcessEnv = { ...process.env, VITEST: undefined };
    loadRepoEnv({ env: localEnv });
    const host = localEnv.PG_HOST ?? "localhost";
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Integration test requires a local PostgreSQL host");
    pool = new pg.Pool({ host, port: Number(localEnv.PG_PORT) || 5432, user: localEnv.PG_USER ?? "postgres",
      password: localEnv.PG_PASSWORD, database: localEnv.PG_DATABASE ?? "lot", connectionTimeoutMillis: 3000,
      options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await pool.query(`CREATE TABLE conversations(id UUID PRIMARY KEY,user_id TEXT,active_run_id UUID,run_started_at TIMESTAMPTZ,
      next_seq BIGINT DEFAULT 0,metadata JSONB DEFAULT '{}',agent_id TEXT DEFAULT 'general');
      CREATE TABLE messages(id UUID PRIMARY KEY,conversation_id UUID,role TEXT,content TEXT,tool_call_id TEXT,
        token_count INTEGER,model TEXT,latency_ms INTEGER,metadata JSONB,status TEXT,seq BIGINT);
      CREATE TABLE tasks(id UUID PRIMARY KEY,type TEXT,user_id TEXT,input JSONB,status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,error TEXT,error_code TEXT,updated_at TIMESTAMPTZ DEFAULT now());`);
    await agentRunState.up(pool);
    await pool.query(`INSERT INTO conversations(id,user_id,active_run_id,run_started_at) VALUES($1,'owner',$2,now())`, [conversationId, firstRun]);
    repository = new RunRepository(pool);
    db = Object.create(DB.prototype) as DB;
    Object.defineProperty(db, "pool", { value: pool });
  });
  afterAll(async () => {
    if (schemaCreated) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it("recovers a crashed write, blocks replay, and isolates ownership", async () => {
    await repository.begin(firstRun, conversationId, "owner", sourceMessageId, "Create a product");
    const call = { id: "call-1", name: "create_product", arguments: { name: "Product", price: 12 } };
    const first = await repository.journal(firstRun, conversationId, "owner").start(call, 1, "write");
    // Process died after recording intent; a newer request reclaimed its lease.
    const nextRun = randomUUID();
    await pool.query(`UPDATE conversations SET active_run_id=$2 WHERE id=$1`, [conversationId, nextRun]);
    await repository.begin(nextRun, conversationId, "owner", randomUUID(), "Continue");
    const recovered = await repository.journal(nextRun, conversationId, "owner").start({ ...call, id: "call-2", arguments: { price: 12, name: "Product" } }, 1, "write");
    expect(recovered.operationId).toBe(first.operationId);
    expect(recovered.result?.errorKind).toBe("unknown_outcome");
    expect(await repository.list(conversationId, "someone-else")).toEqual([]);
    await expect(repository.journal(nextRun, conversationId, "someone-else").start(call, 1, "write")).rejects.toThrow(/lease/);
    await expect(repository.journal(firstRun, conversationId, "owner").start(call, 2, "write")).rejects.toThrow(/lease/);
    expect(await repository.recoveryContext(conversationId, "owner")).toContain(first.operationId);
    await repository.finish(nextRun, "unknown_outcome", { totalTokens: 10 });
    const runs = await repository.list(conversationId, "owner");
    expect(runs.find(r => r.id === nextRun).status).toBe("unknown_outcome");
    // Verification is owner-only and cannot race an active request.
    expect(await repository.resolve(conversationId, "owner", first.operationId, "failed")).toBe(false);
    await pool.query(`UPDATE conversations SET active_run_id=NULL WHERE id=$1`, [conversationId]);
    expect(await repository.resolve(conversationId, "someone-else", first.operationId, "failed")).toBe(false);
    expect(await repository.resolve(conversationId, "owner", first.operationId, "failed")).toBe(true);
    expect(await repository.resolve(conversationId, "owner", first.operationId, "failed")).toBe(false);
    const retryRun = randomUUID();
    await pool.query(`UPDATE conversations SET active_run_id=$2 WHERE id=$1`, [conversationId, retryRun]);
    await repository.begin(retryRun, conversationId, "owner", randomUUID(), "Retry the verified operation");
    const journal = repository.journal(retryRun, conversationId, "owner");
    const retry = await journal.start(call, 1, "write");
    expect(retry.operationId).not.toBe(first.operationId);
    expect(retry.result).toBeUndefined();
    await journal.finish(retry.operationId, { content: "created artifact-1" });
    expect((await journal.start(call, 1, "write")).result).toEqual({ content: "created artifact-1" });
    await repository.finish(retryRun, "completed", {});
  });

  it("rejects late message writes after lease ownership changes", async () => {
    await expect(db.addMessage(randomUUID(), conversationId, "assistant", "late", { runId: firstRun })).rejects.toThrow(/lease/);
    expect((await pool.query("SELECT * FROM messages WHERE content='late'")).rows).toHaveLength(0);
  });

  it("invalidates summaries atomically only when the deletion boundary belongs to the conversation", async () => {
    const messageId = randomUUID();
    await db.addMessage(messageId, conversationId, "user", "old");
    await pool.query(`UPDATE conversations SET metadata='{"contextSummary":{"count":2,"text":"old"},"keep":true}' WHERE id=$1`, [conversationId]);
    expect(await db.deleteMessagesFromAndAfter(conversationId, randomUUID())).toBe(false);
    expect((await pool.query("SELECT metadata FROM conversations WHERE id=$1", [conversationId])).rows[0].metadata.contextSummary).toBeDefined();
    expect(await db.deleteMessagesFromAndAfter(conversationId, messageId)).toBe(true);
    expect((await pool.query("SELECT metadata FROM conversations WHERE id=$1", [conversationId])).rows[0].metadata).toEqual({ keep: true });
  });

  it("creates media task and receipt together under the active lease, then fences late delivery", async () => {
    const id = randomUUID(), runId = randomUUID(), messageId = randomUUID(), taskId = randomUUID(), userMessageId = randomUUID();
    await pool.query("INSERT INTO conversations(id,user_id,active_run_id) VALUES($1,'owner',$2)", [id, runId]);
    await db.addMessage(userMessageId, id, "user", "Generate a clip", { runId });
    const request = {
      taskId, messageId, runId, conversationId: id, userId: "owner", agentId: "general", type: "video.generate", model: "grok-imagine-video-1.5",
      job: { conversationId: id, assistantMessageId: messageId }, metadata: { taskId, chatGeneration: true, status: "generating" },
    };
    expect(await db.createChatGeneration({ ...request, userId: "other" })).toBe(false);
    expect(await db.createChatGeneration({ ...request, runId: randomUUID() })).toBe(false);
    expect(await db.getTask(taskId)).toBeNull();
    expect(await db.getGenerationMessage(messageId, id, "owner")).toBeNull();
    expect(await db.createChatGeneration(request)).toBe(true);
    expect(await db.deleteMessagesFromAndAfter(id, userMessageId)).toBe("paid_generation");
    expect(await db.failUnpublishedChatGeneration(taskId, messageId, "Queue unavailable")).toBe(true);
    expect(await db.getTask(taskId)).toMatchObject({ status: "failed" });
    expect(await db.getGenerationMessage(messageId, id, "owner")).toMatchObject({
      status: "failed", metadata: { status: "failed", chatGeneration: true, error: "Queue unavailable" },
    });

    const nextTaskId = randomUUID(), nextMessageId = randomUUID();
    expect(await db.createChatGeneration({
      ...request, taskId: nextTaskId, messageId: nextMessageId, job: { ...request.job, assistantMessageId: nextMessageId },
      metadata: { ...request.metadata, taskId: nextTaskId },
    })).toBe(true);
    await pool.query("UPDATE tasks SET status='running', attempts=1 WHERE id=$1", [nextTaskId]);
    expect(await db.failUnpublishedChatGeneration(nextTaskId, nextMessageId, "Late queue response")).toBe(false);
    await db.setTaskError(nextTaskId, "Worker could not initialize", "MODEL_AUTH_REQUIRED");
    expect(await db.getGenerationMessage(nextMessageId, id, "owner")).toMatchObject({ status: "failed", model: "grok-imagine-video-1.5" });
  });
});
