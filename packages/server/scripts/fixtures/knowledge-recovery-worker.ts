/** Child process used only by the opt-in recovery test. Never calls a model. */
import { Worker } from "bullmq";
import pg from "pg";
import { KnowledgeJobs } from "../../src/knowledge/ingestion/jobs.js";
import { indexProfile } from "../../src/knowledge/ingestion/profile.js";
import { indexArtifact } from "../../src/knowledge/ingestion/indexer.js";
import { textBlocks } from "../../src/knowledge/ingestion/text.js";
import { knowledgeRedisOptions } from "../../src/knowledge/ingestion/config.js";
if (!process.send || !process.env.RAG_RECOVERY_QUEUE?.startsWith("lot-knowledge-recovery-")) throw new Error("Test child only");
const pool = new pg.Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
const jobs = new KnowledgeJobs(pool, 10); const pause = process.env.RAG_RECOVERY_PAUSE === "1";
const profile = indexProfile(`https://${process.env.RAG_RECOVERY_QUEUE}.invalid/v1`);
if (pause) {
  const original = jobs.checkpoint.bind(jobs);
  jobs.checkpoint = async (...args) => { const saved = await original(...args); process.send!({ state: "checkpoint" }); await new Promise(() => {}); return saved; };
}
const worker = new Worker(process.env.RAG_RECOVERY_QUEUE, async (job) => {
  const lease = await jobs.claim(job.data.taskId, process.env.RAG_RECOVERY_QUEUE!);
  if (!lease) throw new Error("LEASE_NOT_READY");
  const result = await indexArtifact(jobs, lease, profile, { parserVersion: "fixture", diagnostics: [], blocks: textBlocks("进程恢复验收资料") }, async () => {
    if (!pause) throw new Error("CHECKPOINT_NOT_REUSED");
    return { tokens: 8, vector: Array.from({ length: 1024 }, (_, n) => n ? 0 : 1) };
  });
  if (!result) throw new Error("PUBLISH_FAILED");
  process.send!({ state: "published" });
}, { connection: { ...knowledgeRedisOptions(), maxRetriesPerRequest: null }, lockDuration: 1000, stalledInterval: 1000, maxStalledCount: 2 });
worker.on("error", () => process.send!({ state: "error" }));
worker.on("failed", (_job, error) => process.send!({ state: "failed", code: error.message }));
process.on("SIGTERM", () => { void worker.close().then(() => pool.end()).then(() => process.exit(0)); });
