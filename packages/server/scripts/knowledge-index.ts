import "../src/load-env.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DB } from "../src/db/database.js";
import { KnowledgeUuidSchema } from "@lot-agent/core";
import { KnowledgeProfileBuild } from "../src/knowledge/ingestion/profile-build.js";
import { indexProfile } from "../src/knowledge/ingestion/profile.js";
import { createUserEmbedder } from "../src/knowledge/ingestion/runtime.js";
import { parseIsolated } from "../src/knowledge/ingestion/parser-process.js";
import { LocalKnowledgeStorage } from "../src/knowledge/private-storage.js";
import { PARSER_VERSION } from "../src/knowledge/ingestion/version.js";
import type { ParsedArtifact } from "../src/knowledge/ingestion/parsers.js";
const [operation, ownerArg, value, versionArg] = process.argv.slice(2);
const owner = KnowledgeUuidSchema.parse(ownerArg);
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
const manager = new KnowledgeProfileBuild(db.pool); const base = process.env.OPENAI_BASE_URL ?? "https://tokenhub.wetok.ai/v1";
try {
  if (operation === "start") {
    const dimensions = Number(value); const target = indexProfile(base, { dimensions, modelId: versionArg ?? "qwen3.7-text-embedding" });
    console.log({ buildId: await manager.start(owner, indexProfile(base), target), targetProfileId: target.id });
  } else if (operation === "build") {
    const id = KnowledgeUuidSchema.parse(value); const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const storage = new LocalKnowledgeStorage(resolve(root, "data/knowledge"));
    console.log(await manager.build(owner, id, async (itemId, revisionId) => {
      const saved = (await db.pool.query("SELECT artifact FROM rag_ingestion_runs WHERE owner_id=$1 AND item_id=$2 AND revision_id=$3 AND artifact IS NOT NULL ORDER BY generation DESC LIMIT 1", [owner, itemId, revisionId])).rows[0]?.artifact;
      const cached = saved?.parser ?? saved;
      if (cached?.parserVersion === PARSER_VERSION) return cached as ParsedArtifact;
      const row = (await db.pool.query(`SELECT i.source_type,r.content,r.mime,r.description,o.storage_key FROM rag_items i JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id
        LEFT JOIN rag_objects o ON o.owner_id=r.owner_id AND o.id=r.object_id WHERE i.owner_id=$1 AND i.id=$2 AND r.id=$3 AND i.deleted_at IS NULL`, [owner, itemId, revisionId])).rows[0];
      if (!row) throw new Error("REVISION_NOT_FOUND");
      const artifact = await parseIsolated(resolve(root, "packages/server/dist/workers/knowledge-parser.js"), { mime: ["note", "profile_fact"].includes(row.source_type) ? "text/plain" : row.source_type === "bookmark" ? "bookmark" : row.mime, content: row.content ?? undefined, description: row.description,
        path: row.storage_key && row.source_type === "document" ? storage.localPath(row.storage_key) : undefined });
      if (row.source_type === "profile_fact") artifact.blocks = artifact.blocks.map((block) => ({ ...block, origin: "confirmed_fact" }));
      return artifact;
    }, (profile) => createUserEmbedder(db, profile, owner)));
  } else if (operation === "switch") console.log(await manager.switch(owner, KnowledgeUuidSchema.parse(value), Number(versionArg)));
  else if (operation === "rollback") console.log(await manager.rollback(owner, Number(value)));
  else if (operation === "cancel") console.log({ cancelled: await manager.cancel(owner, KnowledgeUuidSchema.parse(value)) });
  else if (operation === "status") console.log({ state: (await db.pool.query("SELECT * FROM rag_user_index_state WHERE owner_id=$1", [owner])).rows, builds: (await db.pool.query("SELECT id,status,source_profile_id,target_profile_id,updated_at FROM rag_profile_builds WHERE owner_id=$1 ORDER BY created_at DESC", [owner])).rows });
  else throw new Error("Usage: knowledge:index start OWNER DIMENSIONS [MODEL] | build OWNER BUILD_ID | switch OWNER BUILD_ID VERSION | rollback OWNER VERSION | cancel OWNER BUILD_ID | status OWNER. Build bills the owner.");
} finally { await db.close(); }
