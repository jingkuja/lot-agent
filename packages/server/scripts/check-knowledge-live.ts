/** Explicit opt-in: spends the latest signed-in user's TokenHub quota on synthetic text. */
import "../src/load-env.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { DB } from "../src/db/database.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgeRetriever } from "../src/knowledge/retrieval.js";
import { indexProfile } from "../src/knowledge/ingestion/profile.js";
import { createUserEmbedder } from "../src/knowledge/ingestion/runtime.js";
import { knowledgeRedisOptions } from "../src/knowledge/ingestion/config.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { migrations } from "../src/db/migrations/index.js";
if (!process.argv.includes("--live") || !process.argv.includes("--latest-user")) throw new Error("Requires --live --latest-user; this bills the selected user's key");
if (!["localhost", "127.0.0.1", "::1"].includes(process.env.PG_HOST ?? "localhost")) throw new Error("Local test database only");
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
const queueName = `lot-knowledge-live-${randomUUID()}`;
const repo = new KnowledgeRepository(db.pool, queueName);
let owner: string | undefined; let collection: string | undefined; let item: string | undefined; let task: string | undefined;
let worker: ReturnType<typeof spawn> | undefined;
const queue = new Queue(queueName, { connection: { ...knowledgeRedisOptions(), maxRetriesPerRequest: 1 } });
queue.on("error", () => {});
try {
  await runMigrations(db.pool, migrations);
  owner = (await db.pool.query("SELECT user_id FROM sessions ORDER BY last_seen_at DESC LIMIT 1")).rows[0]?.user_id;
  if (!owner || !await db.getUserApiKey(owner, process.env.NEW_API_MANAGED_KEYS !== "0")) throw new Error("Selected user has no credential");
  collection = (await repo.createCollection(owner, { name: "S2 自动验证（临时数据）", description: "结束后清理测试资料，保留真实用量记录" }, randomUUID())).id;
  const created = await repo.createItem(owner, { sourceType: "note", title: "离线资料使用说明", content: "产品支持离线查看已下载资料。离线前需要先完成资料下载。", description: "", tags: ["S2验证"], collectionIds: [collection] }, randomUUID());
  item = created.id; task = created.taskId!;
  worker = spawn(process.execPath, [fileURLToPath(new URL("../dist/workers/knowledge.js", import.meta.url))], { env: { ...process.env, KNOWLEDGE_QUEUE: queueName, KNOWLEDGE_CONCURRENCY: "1" }, stdio: ["ignore", "ignore", "ignore"] });
  let succeeded = false;
  for (let n = 0; n < 120; n++) {
    if (worker.exitCode !== null) throw new Error("Live worker exited");
    const state = (await db.pool.query("SELECT status,error FROM tasks WHERE id=$1", [task])).rows[0];
    if (state.status === "failed") throw new Error(`Live ingestion failed: ${state.error}`);
    if (state.status === "succeeded") { succeeded = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!succeeded) throw new Error("Live worker timed out");
  const profile = indexProfile(process.env.OPENAI_BASE_URL!);
  const retriever = new KnowledgeRetriever(db.pool, profile, (user) => createUserEmbedder(db, profile, user));
  const result = await retriever.retrieve({ ownerId: owner, collectionIds: [collection], callerKind: "internal", permission: "retrieval:read" }, {
    query: "如何离线查看资料？", collectionIds: [collection], topK: 5, mode: "hybrid", sourceTypes: ["note"], tags: ["S2验证"], allowDegraded: false,
  });
  if (result.degraded || result.results.length !== 1 || result.results[0].itemId !== item || result.results[0].citation?.kind !== "text") throw new Error("Live retrieval did not return the expected source");
  const usage = await db.pool.query("SELECT count(*)::int AS calls,sum(input_tokens)::int AS tokens,sum(total_cost)::float8 AS cost FROM rag_embedding_charges WHERE task_id=$1", [task]);
  console.log(JSON.stringify({ ownerId: owner, queue: "isolated knowledge queue", worker: "compiled", mode: result.modeUsed, hits: result.results.length, citation: result.results[0].citation, indexingUsage: usage.rows[0] }));
} finally {
  if (worker && worker.exitCode === null) {
    const exited = new Promise<void>((resolve) => worker!.once("exit", () => resolve()));
    worker.kill("SIGTERM"); const force = setTimeout(() => worker!.kill("SIGKILL"), 5000); await exited; clearTimeout(force);
  }
  await queue.obliterate({ force: true }).catch(() => {}); await queue.close();
  if (owner && item) await db.pool.query("DELETE FROM rag_items WHERE owner_id=$1 AND id=$2", [owner, item]);
  if (owner && collection) await db.pool.query("DELETE FROM rag_collections WHERE owner_id=$1 AND id=$2", [owner, collection]);
  if (owner && task) await db.pool.query("DELETE FROM tasks WHERE user_id=$1 AND id=$2", [owner, task]);
  await db.close();
}
