import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { KnowledgeRepository } from "../repository.js";
import { runMigrations } from "../../db/migration-runner.js";
import { migrations } from "../../db/migrations/index.js";
import { indexProfile } from "./profile.js";
import { afterAll, expect, it, describe } from "vitest";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { knowledgeRedisOptions, KNOWLEDGE_JOB_TYPE } from "./config.js";
import { deliverKnowledgeTask } from "./outbox.js";

describe.skipIf(process.env.RAG_REDIS_INTEGRATION !== "1")("knowledge Redis transport", () => {
  let queue: Queue;
  afterAll(async () => { if (queue) { await queue.obliterate({ force: true }); await queue.close(); } });
  it("delivers the persisted task ID once to a separate queue", async () => {
    const options = knowledgeRedisOptions();
    if (!["localhost", "127.0.0.1", "::1"].includes(options.host)) throw new Error("Local Redis only");
    queue = new Queue(`lot-knowledge-test-${randomUUID()}`, { connection: { ...options, maxRetriesPerRequest: 1, commandTimeout: 5000 } });
    const id = randomUUID();
    await deliverKnowledgeTask(queue, id); await deliverKnowledgeTask(queue, id);
    expect(await queue.getWaitingCount()).toBe(1);
    const job = await queue.getJob(id);
    expect(job?.name).toBe(KNOWLEDGE_JOB_TYPE); expect(job?.data).toEqual({ taskId: id });
    expect(job?.opts.attempts).toBe(3);
  });
  it("recovers a SIGKILLed process through BullMQ stalled delivery and reuses the persisted vector checkpoint", async () => {
    const pool = new pg.Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    const owner = randomUUID(); const name = `lot-knowledge-recovery-${owner}`;
    const profile = indexProfile(`https://${name}.invalid/v1`);
    const transport = new Queue(name, { connection: { ...knowledgeRedisOptions(), maxRetriesPerRequest: 1 } });
    let child: ChildProcess | undefined;
    const wait = (process: ChildProcess, state: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not reach ${state}`)); }, 15000);
      const onMessage = (message: { state: string; code?: string }) => { if (message.state === state) { cleanup(); resolve(); } else if (["failed", "error"].includes(message.state)) { cleanup(); reject(new Error(message.code ?? "Child error")); } };
      const onExit = () => { cleanup(); reject(new Error("Child exited")); };
      const cleanup = () => { clearTimeout(timer); process.off("message", onMessage); process.off("exit", onExit); };
      process.on("message", onMessage); process.once("exit", onExit);
    });
    const start = (pause: boolean) => spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx/esm"), fileURLToPath(new URL("../../../scripts/fixtures/knowledge-recovery-worker.ts", import.meta.url))], {
      env: { ...process.env, RAG_RECOVERY_QUEUE: name, RAG_RECOVERY_PAUSE: pause ? "1" : "0" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const stop = async (signal: NodeJS.Signals) => { if (child && child.exitCode === null && child.signalCode === null) { const done = new Promise<void>((resolve) => child!.once("exit", () => resolve())); child.kill(signal); await done; } };
    try {
      await runMigrations(pool, migrations); await pool.query("INSERT INTO users(id,name) VALUES($1,'recovery fixture')", [owner]);
      const item = await new KnowledgeRepository(pool, name).createItem(owner, { sourceType: "note", title: "恢复", content: "进程恢复验收资料", description: "", tags: [], collectionIds: [] }, randomUUID());
      await deliverKnowledgeTask(transport, item.taskId!); child = start(true); await wait(child, "checkpoint"); await stop("SIGKILL");
      // Speed up only this fixture's durable lease expiry; BullMQ must still discover its lost lock.
      await pool.query("UPDATE rag_ingestion_runs SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1", [item.taskId]);
      child = start(false); await wait(child, "published"); await stop("SIGTERM");
      expect((await pool.query("SELECT status,attempts FROM tasks WHERE id=$1", [item.taskId])).rows[0]).toMatchObject({ status: "succeeded", attempts: 2 });
      expect((await pool.query("SELECT count(*)::int AS n FROM rag_chunks WHERE owner_id=$1", [owner])).rows[0].n).toBe(1);
    } finally {
      await stop("SIGKILL"); await transport.obliterate({ force: true }); await transport.close();
      await pool.query("DELETE FROM tasks WHERE user_id=$1", [owner]); await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      await pool.query("DELETE FROM rag_index_spaces WHERE profile_id=$1", [profile.id]); await pool.query("DELETE FROM rag_index_profiles WHERE id=$1", [profile.id]); await pool.end();
    }
  }, 40000);

});
