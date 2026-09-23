import "../load-env.js";
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
  const config = knowledgeQueueConfig();
  const profile = indexProfile(process.env.OPENAI_BASE_URL ?? "https://tokenhub.wetok.ai/v1");
  const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
  // Server owns migrations. Do not consume anything before the required schema is present.
  await assertKnowledgeJobsReady(db.pool);
  const root = resolve(dirname(process.argv[1]), "../../../..");
  const parserPath = resolve(dirname(process.argv[1]), `knowledge-parser.${process.argv[1].endsWith(".ts") ? "ts" : "js"}`);
  const storage = new LocalKnowledgeStorage(resolve(root, "data/knowledge"));
  const connection = { ...knowledgeRedisOptions(), maxRetriesPerRequest: null };
  const queue = new Queue(config.queueName, { connection: { ...knowledgeRedisOptions(), maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 5000 } });
  const jobs = new KnowledgeJobs(db.pool);
  const worker = createKnowledgeConsumer(connection, config.queueName, config.concurrency, jobs, async (lease, signal) => {
    const indexed = await jobs.readCheckpoint(lease, `index-v1-${profile.id}`) as { parser: ParsedArtifact } | null;
    let artifact = indexed?.parser ?? await jobs.readCheckpoint(lease, PARSER_VERSION) as ParsedArtifact | null;
    if (!artifact) {
      const { rows } = await db.pool.query(`SELECT r.content,r.mime,r.description,i.source_type,o.storage_key FROM rag_item_revisions r
        JOIN rag_items i ON i.owner_id=r.owner_id AND i.id=r.item_id LEFT JOIN rag_objects o ON o.owner_id=r.owner_id AND o.id=r.object_id
        WHERE r.owner_id=$1 AND r.item_id=$2 AND r.id=$3`, [lease.ownerId, lease.itemId, lease.revisionId]);
      if (!rows[0]) throw new Error("REVISION_NOT_FOUND");
      const row = rows[0];
      artifact = await parseIsolated(parserPath, {
        mime: row.source_type === "note" ? "text/plain" : row.source_type === "bookmark" ? "bookmark" : row.mime,
        content: row.content ?? undefined, description: row.description,
        path: row.storage_key && row.source_type === "document" ? storage.localPath(row.storage_key) : undefined,
      }, signal);
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
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true; clearInterval(timer);
    await worker.close(); await queue.close(); await db.close();
  };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
  console.log(`Knowledge worker listening on ${config.queueName}`);
}
main().catch(() => { console.error("Knowledge worker failed to start; check schema and dependencies"); process.exitCode = 1; });
