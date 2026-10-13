import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { KnowledgeRepository } from "../knowledge/repository.js";
import { KnowledgeMaterials } from "../knowledge/materials.js";
import { LocalKnowledgeStorage } from "../knowledge/private-storage.js";
import { knowledgeQueueConfig } from "../knowledge/ingestion/config.js";
import { MarketingError, PgMarketingProjectStore } from "./repository.js";

export async function archiveMarketingVideo(store: PgMarketingProjectStore, owner: string, id: string, dataRoot: string) {
  const connection = await store.pool.connect();
  const lock = `marketing-library:${owner}`;
  try {
    await connection.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
    const p = await store.get(owner, id);
    if (!p) throw new MarketingError("草稿不存在", 404);
    if (p.status !== "succeeded" || !p.output?.assetIds.length) throw new MarketingError("请等待视频生成完成。");
    const repository = new KnowledgeRepository(store.pool, process.env.KNOWLEDGE_INGESTION_ENABLED === "1" ? knowledgeQueueConfig().queueName : undefined);
    const title = (p.draft.publishTitle.trim() || p.draft.topic.trim() || "营销视频").slice(0, 255);
    const description = `口播文案：\n${p.draft.script}\n\n发布标题：${p.draft.publishTitle}\n话题：${p.draft.tags}\n制作草稿：${p.id}`;
    const tags = [...new Set(["marketing-video", ...p.draft.tags.split(/[\s#，,]+/).filter(Boolean).map(tag => tag.slice(0, 64))])].slice(0, 20);
    const live = (await store.pool.query("SELECT id FROM rag_items WHERE owner_id=$1 AND source_asset_id=$2 AND deleted_at IS NULL", [owner, p.output.assetIds[0]])).rows[0];
    let itemId: string = live?.id;
    if (!itemId) {
      const previous = (await store.pool.query("SELECT count(*)::int AS count FROM rag_items WHERE owner_id=$1 AND source_asset_id=$2", [owner, p.output.assetIds[0]])).rows[0].count;
      let library = (await store.pool.query("SELECT id FROM rag_collections WHERE owner_id=$1 AND tags @> ARRAY['marketing-video']::text[] AND deleted_at IS NULL ORDER BY created_at LIMIT 1", [owner])).rows[0];
      if (!library) library = await repository.createCollection(owner, { name: "营销视频", description: "营销视频、文案与发布信息", tags: ["marketing-video"] }, randomUUID());
      const materials = new KnowledgeMaterials(repository, new LocalKnowledgeStorage(resolve(dataRoot, "knowledge")), dataRoot);
      const archived = await materials.archive(owner, p.output.assetIds[0], title, description, [library.id], tags, `marketing-${p.id}-${p.version}-${previous}`);
      itemId = archived.id;
    }
    const item = await repository.getItem(owner, itemId);
    if (item.title !== title || item.description !== description || JSON.stringify([...item.tags].sort()) !== JSON.stringify([...tags].sort())) {
      await repository.updateItem(owner, itemId, { version: item.version, title, description, tags });
    }
    await store.pool.query("UPDATE marketing_video_projects SET knowledge_item_id=$3,knowledge_version=$4 WHERE id=$1 AND user_id=$2", [id, owner, itemId, p.version]);
    return { itemId, version: p.version };
  } finally {
    try { await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]); }
    finally { connection.release(); }
  }
}
