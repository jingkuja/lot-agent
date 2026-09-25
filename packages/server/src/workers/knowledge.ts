import { reconcilePendingEmbeddingReceipts } from "../knowledge/ingestion/receipts.js";
import { activeProfile } from "../knowledge/ingestion/spaces.js";
import "../load-env.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { calcCost, type ModelConfig } from "@lot-agent/core";
import { UsageMeter } from "../billing/meter.js";
import { resolvePricing, type ModelCatalogConfig } from "../models/catalog.js";
import { createUserOcr, OCR_MODEL, OCR_MAX_TOKENS } from "../knowledge/ingestion/ocr.js";
import { resolve, dirname } from "node:path";
import { Queue } from "bullmq";
import { DB } from "../db/database.js";
import { LocalKnowledgeStorage } from "../knowledge/private-storage.js";
import { KnowledgeJobs } from "../knowledge/ingestion/jobs.js";
import { knowledgeQueueConfig, knowledgeRedisOptions } from "../knowledge/ingestion/config.js";
import { assertKnowledgeJobsReady, deliverKnowledgeTask, dispatchKnowledgeOutbox } from "../knowledge/ingestion/outbox.js";
import { createKnowledgeConsumer } from "../knowledge/ingestion/consumer.js";
import { parseIsolated } from "../knowledge/ingestion/parser-process.js";
import { PARSER_VERSION } from "../knowledge/ingestion/version.js";

import { indexProfile } from "../knowledge/ingestion/profile.js";
import { indexArtifact } from "../knowledge/ingestion/indexer.js";
import { createUserEmbedder } from "../knowledge/ingestion/runtime.js";
import type { ParsedArtifact } from "../knowledge/ingestion/parsers.js";

async function main() {
  if (process.env.KNOWLEDGE_INGESTION_ENABLED !== "1") {
    console.log("Knowledge ingestion disabled; worker not started");
    return;
  }
  const config = knowledgeQueueConfig();
  const defaultProfile = indexProfile(process.env.OPENAI_BASE_URL ?? "https://tokenhub.wetok.ai/v1");
  const db = new DB({ max: config.poolMax, host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
  // Server owns migrations. Do not consume anything before the required schema is present.
  // `pnpm dev` starts server and workers together. Allow the server to finish
  // its migrations before claiming any tasks on a fresh installation.
  for (let attempt = 0; ; attempt++) {
    try { await assertKnowledgeJobsReady(db.pool); break; }
    catch (error) {
      if (attempt >= 29) { await db.close(); throw error; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const root = resolve(dirname(process.argv[1]), "../../../..");
  const rawConfig = JSON.parse(await readFile(resolve(root, "config/default.json"), "utf8")) as { models?: ModelConfig[]; modelCatalog: ModelCatalogConfig; llm?: { openai?: { baseUrl?: string } } };
  const ocrModel: ModelConfig = rawConfig.models?.find((model) => model.id === OCR_MODEL) ?? {
    id: OCR_MODEL, type: "llm", provider: "openai", billingUnit: "token", enabled: true,
    ...resolvePricing(rawConfig.modelCatalog, OCR_MODEL, "llm"),
  };
  const ocrMeter = new UsageMeter(db, (id) => id === OCR_MODEL ? ocrModel : undefined);
  const ocrBaseUrl = process.env.OPENAI_BASE_URL ?? rawConfig.llm?.openai?.baseUrl ?? "https://tokenhub.wetok.ai/v1";
  const parserPath = resolve(dirname(process.argv[1]), `knowledge-parser.${process.argv[1].endsWith(".ts") ? "ts" : "js"}`);
  const storage = new LocalKnowledgeStorage(resolve(root, "data/knowledge"));
  const connection = { ...knowledgeRedisOptions(), maxRetriesPerRequest: null };
  const queue = new Queue(config.queueName, { connection: { ...knowledgeRedisOptions(), maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 5000 } });
  const jobs = new KnowledgeJobs(db.pool);
  const worker = createKnowledgeConsumer(connection, config.queueName, config.concurrency, jobs, async (lease, signal) => {
    const profile = await activeProfile(db.pool, lease.ownerId, defaultProfile);
    const indexed = await jobs.readCheckpoint(lease, `index-v1-${profile.id}`) as { parser: ParsedArtifact } | null;
    let artifact = indexed?.parser ?? await jobs.readCheckpoint(lease, PARSER_VERSION) as ParsedArtifact | null;
    if (!artifact) {
      const { rows } = await db.pool.query(`SELECT r.content,r.mime,r.description,i.source_type,o.storage_key FROM rag_item_revisions r
        JOIN rag_items i ON i.owner_id=r.owner_id AND i.id=r.item_id LEFT JOIN rag_objects o ON o.owner_id=r.owner_id AND o.id=r.object_id
        WHERE r.owner_id=$1 AND r.item_id=$2 AND r.id=$3`, [lease.ownerId, lease.itemId, lease.revisionId]);
      if (!rows[0]) throw new Error("REVISION_NOT_FOUND");
      const row = rows[0];
      const ocrVersion = `${PARSER_VERSION}-${OCR_MODEL}-pages`;
      const ocrPages = await jobs.readCheckpoint(lease, ocrVersion) as Record<string, string> | null ?? {};
      const recognize = createUserOcr({ db, meter: ocrMeter, ownerId: lease.ownerId, taskId: lease.taskId, baseUrl: ocrBaseUrl,
        estimatedCost: calcCost(ocrModel, { inputCount: 4096, outputCount: OCR_MAX_TOKENS }) });
      artifact = await parseIsolated(parserPath, {
        mime: row.source_type === "note" ? "text/plain" : row.source_type === "bookmark" ? "bookmark" : row.mime,
        content: row.content ?? undefined, description: row.description,
        path: row.storage_key && ["document", "image"].includes(row.source_type) ? storage.localPath(row.storage_key) : undefined,
      }, signal, 30000, async (image, ocrSignal) => {
        const key = `${image.mode ?? "ocr"}-${image.page ?? "image"}-${createHash("sha256").update(image.bytes).digest("hex")}`;
        if (Object.hasOwn(ocrPages, key)) return ocrPages[key];
        if (!await jobs.heartbeat(lease, "ocr", 10)) throw new Error("INGESTION_CANCELLED");
        const text = await recognize(image, ocrSignal);
        ocrPages[key] = text;
        if (!await jobs.checkpoint(lease, ocrVersion, ocrPages)) throw new Error("INGESTION_CANCELLED");
        return text;
      });
      if (row.source_type === "profile_fact") artifact.blocks = artifact.blocks.map((block) => ({ ...block, origin: "confirmed_fact" }));
      if (!await jobs.checkpoint(lease, PARSER_VERSION, artifact)) throw new Error("INGESTION_CANCELLED");
    }
    await indexArtifact(jobs, lease, profile, artifact, createUserEmbedder(db, profile, lease.ownerId, lease.taskId), signal);
  });
  worker.on("error", () => console.warn("[knowledge] worker transport unavailable"));
  queue.on("error", () => {});
  let dispatching = false;
  const dispatch = async () => {
    if (dispatching) return; dispatching = true;
    try { await dispatchKnowledgeOutbox(db.pool, config.queueName, (id) => deliverKnowledgeTask(queue, id)); }
    catch { console.warn("[knowledge] delivery deferred"); }
    finally { dispatching = false; }
  };
  await dispatch();
  const timer = setInterval(() => void dispatch(), 5000);
  let reconciling: Promise<void> | undefined;
  const receiptAbort = new AbortController();
  const reconcile = () => {
    if (reconciling) return;
    reconciling = reconcilePendingEmbeddingReceipts(db, receiptAbort.signal).catch(() => {
      console.warn("[knowledge] receipt reconciliation deferred");
    }).finally(() => { reconciling = undefined; });
  };
  reconcile();
  const receiptTimer = setInterval(reconcile, 30000);
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true; clearInterval(timer); clearInterval(receiptTimer); receiptAbort.abort();
    await reconciling;
    await worker.close(); await queue.close(); await db.close();
  };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
  console.log(`Knowledge worker listening on ${config.queueName}`);
}
main().catch(() => { console.error("Knowledge worker failed to start; check schema and dependencies"); process.exitCode = 1; });
