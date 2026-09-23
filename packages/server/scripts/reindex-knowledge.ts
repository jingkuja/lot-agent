import "../src/load-env.js";
import { DB } from "../src/db/database.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { knowledgeQueueConfig } from "../src/knowledge/ingestion/config.js";
import { KnowledgeUuidSchema } from "@lot-agent/core";
const owner = KnowledgeUuidSchema.parse(process.argv[2]);
const itemId = KnowledgeUuidSchema.parse(process.argv[3]);
const expectedVersion = Number(process.argv[4]);
if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("Usage: knowledge:reindex OWNER_UUID ITEM_UUID EXPECTED_VERSION (bills the item's owner)");
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
try {
  const repository = new KnowledgeRepository(db.pool, knowledgeQueueConfig().queueName);
  const item = await repository.getItem(owner, itemId);
  if (item.version !== expectedVersion || item.pendingRevisionId) throw new Error("Item changed or has a pending revision; resolve it before rebuilding");
  // Same source, new revision; the active index remains available until successful publication.
  const result = await repository.updateItem(owner, itemId, { version: expectedVersion, title: item.title, description: item.description, tags: item.tags });
  console.log(JSON.stringify(result));
} finally { await db.close(); }
