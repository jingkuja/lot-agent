import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { PrivateKnowledgeStorage } from "@lot-agent/core";
import { KnowledgeRepository } from "./repository.js";
import { KnowledgeError } from "./errors.js";
import { withKnowledgeStorageLease } from "./storage-lease.js";
// Digital-employee assets keep their original business ownership and are never implicitly personal.
const personal = `a.user_id=$1::text AND NOT EXISTS (
  SELECT 1 FROM tasks t LEFT JOIN conversations c ON c.id::text=t.input->>'conversationId'
  WHERE t.id=a.task_id AND (c.agent_id='digital_employee' OR t.input->>'featureScope'='customer-acquisition'))
  AND NOT EXISTS (SELECT 1 FROM de_marketing_asset_library m WHERE m.task_id=a.task_id)`;
export class KnowledgeMaterials {
  constructor(readonly repository: KnowledgeRepository, readonly storage: PrivateKnowledgeStorage, readonly dataRoot: string) {}
  async list(owner: string, limit = 30, before?: string, beforeId?: string, filter: { type?: string; source?: string; tag?: string; query?: string } = {}) {
    const { rows } = await this.repository.pool.query(`SELECT a.id,a.type,a.mime,a.original_name,a.size_bytes,a.width,a.height,a.duration_sec,a.created_at,a.created_at::text AS cursor_time,
      (SELECT id FROM rag_items i WHERE i.owner_id=$1::uuid AND i.source_asset_id=a.id AND i.deleted_at IS NULL) AS archived_item_id
      FROM assets a WHERE ${personal} AND ($2::timestamptz IS NULL OR (a.created_at,a.id)<($2::timestamptz,COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid))) AND ($5::text IS NULL OR CASE WHEN a.mime LIKE 'image/%' THEN 'image' WHEN a.mime LIKE 'audio/%' THEN 'audio' WHEN a.mime LIKE 'video/%' THEN 'video' ELSE 'document' END=$5)
      AND ($6::text IS NULL OR ($6='upload' AND a.type='upload') OR ($6='generated' AND a.type<>'upload') OR ($6='archived' AND EXISTS(SELECT 1 FROM rag_items i WHERE i.owner_id=$1::uuid AND i.source_asset_id=a.id AND i.deleted_at IS NULL)))
      AND ($7::text IS NULL OR EXISTS(SELECT 1 FROM rag_items i JOIN rag_item_tags t ON t.owner_id=i.owner_id AND t.item_id=i.id WHERE i.owner_id=$1::uuid AND i.source_asset_id=a.id AND i.deleted_at IS NULL AND t.tag=$7))
      AND ($8::text IS NULL OR COALESCE(a.original_name,'素材-'||a.id::text) ILIKE '%'||$8||'%')
      ORDER BY a.created_at DESC,a.id DESC LIMIT $3`, [owner, before ?? null, limit, beforeId ?? null, filter.type || null, filter.source || null, filter.tag || null, filter.query || null]);
    return rows;
  }
  async source(owner: string, assetId: string) {
    const row = (await this.repository.pool.query(`SELECT a.* FROM assets a WHERE ${personal} AND a.id=$2`, [owner, assetId])).rows[0];
    if (!row) throw new KnowledgeError("NOT_FOUND", 404, "素材不存在");
    const folder = row.type === "upload" ? "uploads" : "assets";
    // Only trusted local storage keys; never fetch a public URL supplied by an asset.
    const root = resolve(this.dataRoot, folder); const path = resolve(root, row.storage_key);
    if (!path.startsWith(root + sep) || path === root) throw new KnowledgeError("NOT_FOUND", 404, "素材原件不可用");
    const resolvedRoot = await realpath(root); const resolvedPath = await realpath(path);
    if (!resolvedPath.startsWith(resolvedRoot + sep)) throw new KnowledgeError("NOT_FOUND", 404, "素材原件不可用");
    return { materialSource: row.type === "upload" ? "upload" as const : "generated" as const, path: resolvedPath, mime: row.mime as string, title: row.original_name || `素材-${row.id}`, size: Number(row.size_bytes) };
  }
  async read(owner: string, assetId: string) {
    const source = await this.source(owner, assetId);
    return { file: { ...source, key: source.path }, storage: { size: async (key: string) => (await stat(key)).size, open: (key: string, range?: { start: number; end: number }) => createReadStream(key, range) } };
  }
  async archive(owner: string, assetId: string, title: string, description: string, collectionIds: string[], tags: string[], key: string) {
    if (collectionIds.length !== (await this.repository.findOwnedCollections(owner, collectionIds)).length) throw new KnowledgeError("NOT_FOUND", 404, "知识库不存在");
    const source = await this.source(owner, assetId);
    return withKnowledgeStorageLease(this.repository.pool, owner, async () => {
      const object = await this.storage.put(owner, createReadStream(source.path), source.mime);
      const sourceType = source.mime.startsWith("image/") ? "image" : source.mime.startsWith("audio/") ? "audio" : source.mime.startsWith("video/") ? "video" : "document";
      const item = await this.repository.createItem(owner, { title, description, collectionIds, tags, sourceType, mime: source.mime, object, sourceAssetId: assetId, materialSource: source.materialSource }, key);
      return { ...item, reused: item.reused ?? false };
    });
  }
}
