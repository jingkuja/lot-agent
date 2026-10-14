import "../load-env.js";
import { dirname, resolve } from "node:path";
import { DB } from "../db/database.js";
import { loadLlmConfig } from "../config.js";
import { TokenhubClient } from "../tokenhub/client.js";
import { knowledgeRedisOptions } from "../knowledge/ingestion/config.js";
import { analysisConfig } from "../marketing-analysis/config.js";
import { PgAnalysisStore } from "../marketing-analysis/repository.js";
import { AnalysisStorage } from "../marketing-analysis/storage.js";
import { analysisQueue, createAnalysisConsumer, dispatchAnalyses } from "../marketing-analysis/queue.js";
import { runAnalysis } from "../marketing-analysis/runtime.js";
import { analysisMediaRuntime } from "../marketing-analysis/media-runtime.js";
import { collectAnalysisFiles } from "../marketing-analysis/cleanup.js";

async function main() {
  const config = analysisConfig();
  if (!config.enabled) { console.log("Media analysis disabled; worker not started"); return; }
  const mediaRuntime = analysisMediaRuntime();
  const root = resolve(dirname(process.argv[1]), "../../../..");
  const db = new DB({ max: 6, host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
  for (let attempt = 0; ; attempt++) {
    try { await db.pool.query("SELECT id FROM marketing_reference_analyses LIMIT 0"); break; }
    catch (error) { if (attempt >= 29) { await db.close(); throw error; } await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  const store = new PgAnalysisStore(db.pool); const storage = new AnalysisStorage(resolve(root, "data/marketing-analysis"));
  const llm = await loadLlmConfig(root);
  const hub = new TokenhubClient(process.env.TOKENHUB_BASE_URL ?? "https://tokenhub.todoucloud.com/api/agent-market", undefined, process.env.NEW_API_AGENT_KEY ?? "");
  const queue = analysisQueue({ ...knowledgeRedisOptions(), maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 5000 });
  const consumer = createAnalysisConsumer({ ...knowledgeRedisOptions(), maxRetriesPerRequest: null }, config.concurrency, store,
    (lease, signal) => runAnalysis(lease, signal, { store, storage, db, hub, config, mediaRuntime, baseUrl: llm.openai.baseUrl!, bridgePath: resolve(root, "deploy/media-analysis-proxy-bridge.py") }));
  let dispatching: Promise<void> | undefined;
  const dispatch = () => {
    if (dispatching) return;
    dispatching = dispatchAnalyses(store, queue).catch(() => { console.warn("[media-analysis] delivery deferred"); }).finally(() => { dispatching = undefined; });
  };
  dispatch(); const timer = setInterval(dispatch, 5000);
  let collecting: Promise<void> | undefined;
  const collect = () => {
    if (collecting) return;
    collecting = collectAnalysisFiles(store, storage).catch(() => { console.warn("[media-analysis] file cleanup deferred"); }).finally(() => { collecting = undefined; });
  };
  collect(); const cleanupTimer = setInterval(collect, 60000);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; clearInterval(timer); clearInterval(cleanupTimer); await dispatching; await collecting; await consumer.close(); await queue.close(); await db.close(); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
  console.log("Media analysis worker listening on lot-media-analysis");
}
main().catch(() => { console.error("Media analysis worker failed to start; check configuration and dependencies"); process.exitCode = 1; });
