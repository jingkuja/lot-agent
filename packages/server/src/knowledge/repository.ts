import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PrivateKnowledgeObject } from "@lot-agent/core";
import { KnowledgeError } from "./errors.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const notFound = () => new KnowledgeError("NOT_FOUND", 404, "资料或知识库不存在");
const conflict = () => new KnowledgeError("CONFLICT", 409, "资料已更新，请刷新后重试");
export interface NewKnowledgeItem {
  title: string;
  sourceType: "document" | "note" | "bookmark" | "image" | "audio" | "video";
  description: string;
  content?: string;
  sourceUrl?: string;
  mime?: string;
  object?: PrivateKnowledgeObject;
  collectionIds: string[];
  tags: string[];
}
export interface KnowledgeItemView {
  id: string; title: string; sourceType: string; version: number; generation: number;
  activeRevisionId: string | null; pendingRevisionId: string | null;
  revisionId: string; storageStatus: string; indexStatus: string;
  description: string; content: string | null; sourceUrl: string | null; mime: string | null;
  size: number; collectionIds: string[]; tags: string[]; createdAt: string;
}
export interface KnowledgeFile {
  itemId: string; revisionId: string; generation: number; key: string; mime: string; size: number; title: string;
}
export interface KnowledgeCursor { createdAt: string; id: string }

export class KnowledgeRepository {
  constructor(readonly pool: Pool) {}

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** Cross-process lock and response are inside the same transaction as the mutation. */
  private async idempotent<T>(owner: string, route: string, key: string, input: unknown, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!key || key.length > 128) throw new KnowledgeError("INVALID_REQUEST", 400, "需要 1–128 字符的 Idempotency-Key");
    const hash = digest(JSON.stringify(input));
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([owner, route, key])]);
      const old = await client.query("SELECT request_hash, response FROM rag_idempotency WHERE owner_id=$1 AND route=$2 AND key=$3", [owner, route, key]);
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== hash) throw conflict();
        return old.rows[0].response as T;
      }
      const result = await work(client);
      await client.query("INSERT INTO rag_idempotency (owner_id,route,key,request_hash,response) VALUES ($1,$2,$3,$4,$5)", [owner, route, key, hash, JSON.stringify(result)]);
      return result;
    });
  }

  async createCollection(owner: string, input: { name: string; description: string }, key: string) {
    return this.idempotent(owner, "collections", key, input, async (client) => {
      const result = await client.query("INSERT INTO rag_collections (owner_id,name,description) VALUES ($1,$2,$3) RETURNING id,name,description,version", [owner, input.name, input.description]);
      return result.rows[0];
    });
  }

  async listCollections(owner: string, limit = 30, cursor?: KnowledgeCursor) {
    const { rows } = await this.pool.query(`SELECT c.id,c.name,c.description,c.version,c.created_at,c.created_at::text AS cursor_created_at,
      (SELECT count(*)::int FROM rag_collection_items ci JOIN rag_items i ON i.owner_id=ci.owner_id AND i.id=ci.item_id
        WHERE ci.owner_id=c.owner_id AND ci.collection_id=c.id AND i.deleted_at IS NULL) AS stored_count,
      (SELECT count(*)::int FROM rag_collection_items ci JOIN rag_items i ON i.owner_id=ci.owner_id AND i.id=ci.item_id
        JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=i.active_revision_id
        WHERE ci.owner_id=c.owner_id AND ci.collection_id=c.id AND i.deleted_at IS NULL AND r.index_status='ready') AS searchable_count
      FROM rag_collections c WHERE c.owner_id=$1 AND c.deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2::timestamptz,$3::uuid))
      ORDER BY c.created_at DESC,c.id DESC LIMIT $4`, [owner, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
    const data = rows.slice(0, limit);
    return { data: data.map((row) => ({ id: row.id, name: row.name, description: row.description, version: row.version,
      storedCount: row.stored_count, searchableCount: row.searchable_count, createdAt: row.created_at.toISOString() })),
      nextCursor: rows.length > limit ? this.cursor(data.at(-1)) : null };
  }

  private cursor(row: { cursor_created_at: string; id: string }): KnowledgeCursor {
    return { createdAt: row.cursor_created_at, id: row.id };
  }

  async updateCollection(owner: string, id: string, input: { name: string; description: string; version: number }) {
    return this.transaction(async (client) => {
      const current = await client.query("SELECT version FROM rag_collections WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [owner, id]);
      if (!current.rows[0]) throw notFound();
      if (current.rows[0].version !== input.version) throw conflict();
      const result = await client.query("UPDATE rag_collections SET name=$3,description=$4,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING id,name,description,version", [owner, id, input.name, input.description]);
      return result.rows[0];
    });
  }

  async findOwnedCollections(owner: string, ids: readonly string[]): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT id FROM rag_collections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL", [owner, ids]);
    return rows.map((row) => row.id);
  }

  private async lockCollections(client: PoolClient, owner: string, ids: string[]) {
    if (!ids.length) return;
    const result = await client.query("SELECT id FROM rag_collections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE", [owner, ids]);
    if (result.rows.length !== ids.length) throw notFound();
  }

  async createItem(owner: string, input: NewKnowledgeItem, key: string): Promise<{ id: string; revisionId: string }> {
    return this.idempotent(owner, "items", key, input, async (client) => {
      await this.lockCollections(client, owner, input.collectionIds);
      const id = randomUUID(); const revisionId = randomUUID();
      let objectId: string | null = null;
      if (input.object) {
        const object = await client.query(`INSERT INTO rag_objects (owner_id,sha256,storage_key,byte_size) VALUES ($1,$2,$3,$4)
          ON CONFLICT (owner_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id`, [owner, input.object.sha256, input.object.key, input.object.size]);
        objectId = object.rows[0].id;
      }
      await client.query("INSERT INTO rag_items (id,owner_id,source_type,title,pending_revision_id) VALUES ($1,$2,$3,$4,$5)", [id, owner, input.sourceType, input.title, revisionId]);
      await client.query(`INSERT INTO rag_item_revisions (id,owner_id,item_id,object_id,revision_number,generation,mime,original_name,content,description,source_url,storage_status)
        VALUES ($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,'stored')`, [revisionId, owner, id, objectId, input.mime ?? null, input.object ? input.title : null, input.content ?? null, input.description, input.sourceUrl ?? null]);
      for (const collectionId of input.collectionIds) await client.query("INSERT INTO rag_collection_items (owner_id,collection_id,item_id) VALUES ($1,$2,$3)", [owner, collectionId, id]);
      for (const tag of input.tags) await client.query("INSERT INTO rag_item_tags (owner_id,item_id,tag) VALUES ($1,$2,$3)", [owner, id, tag]);
      return { id, revisionId };
    });
  }

  async getItem(owner: string, id: string): Promise<KnowledgeItemView> {
    const { rows } = await this.pool.query(`SELECT i.*,r.id AS revision_id,r.storage_status,r.index_status,r.description,r.content,r.source_url,r.mime,
      COALESCE(o.byte_size,0) AS byte_size,
      ARRAY(SELECT ci.collection_id FROM rag_collection_items ci JOIN rag_collections c ON c.owner_id=ci.owner_id AND c.id=ci.collection_id
        WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND c.deleted_at IS NULL ORDER BY ci.collection_id) AS collection_ids,
      ARRAY(SELECT tag FROM rag_item_tags t WHERE t.owner_id=i.owner_id AND t.item_id=i.id ORDER BY tag) AS tags
      FROM rag_items i JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=COALESCE(i.pending_revision_id,i.active_revision_id)
      LEFT JOIN rag_objects o ON o.owner_id=r.owner_id AND o.id=r.object_id
      WHERE i.owner_id=$1 AND i.id=$2 AND i.deleted_at IS NULL`, [owner, id]);
    const row = rows[0]; if (!row) throw notFound();
    return { id: row.id, title: row.title, sourceType: row.source_type, version: row.version, generation: row.generation,
      activeRevisionId: row.active_revision_id, pendingRevisionId: row.pending_revision_id, revisionId: row.revision_id,
      storageStatus: row.storage_status, indexStatus: row.index_status, description: row.description, content: row.content,
      sourceUrl: row.source_url, mime: row.mime, size: Number(row.byte_size), collectionIds: row.collection_ids, tags: row.tags, createdAt: row.created_at.toISOString() };
  }

  async listItems(owner: string, limit = 30, cursor?: KnowledgeCursor, collectionId?: string) {
    if (collectionId && !(await this.findOwnedCollections(owner, [collectionId])).length) throw notFound();
    const { rows } = await this.pool.query(`SELECT id,created_at,created_at::text AS cursor_created_at FROM rag_items i WHERE owner_id=$1 AND deleted_at IS NULL
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM rag_collection_items ci WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND ci.collection_id=$4))
      ORDER BY created_at DESC,id DESC LIMIT $5`, [owner, cursor?.createdAt ?? null, cursor?.id ?? null, collectionId ?? null, limit + 1]);
    const selected = rows.slice(0, limit);
    // getItem rechecks ownership/deletion after the listing snapshot.
    const data = await Promise.all(selected.map((row) => this.getItem(owner, row.id)));
    return { data, nextCursor: rows.length > limit ? this.cursor(selected.at(-1)) : null };
  }

  async changeMembership(owner: string, itemId: string, collectionId: string, add: boolean) {
    return this.transaction(async (client) => {
      await this.lockCollections(client, owner, [collectionId]);
      const item = await client.query("SELECT id FROM rag_items WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE", [owner, itemId]);
      if (!item.rows.length) throw notFound();
      if (add) await client.query("INSERT INTO rag_collection_items (owner_id,collection_id,item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [owner, collectionId, itemId]);
      else await client.query("DELETE FROM rag_collection_items WHERE owner_id=$1 AND collection_id=$2 AND item_id=$3", [owner, collectionId, itemId]);
    });
  }

  async updateItem(owner: string, id: string, input: { version: number; title: string; description: string; tags: string[]; content?: string; sourceUrl?: string }) {
    return this.transaction(async (client) => {
      const item = await client.query("SELECT * FROM rag_items WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [owner, id]);
      const row = item.rows[0]; if (!row) throw notFound(); if (row.version !== input.version) throw conflict();
      if (input.content !== undefined && row.source_type !== "note") throw new KnowledgeError("INVALID_REQUEST", 400, "仅笔记可编辑正文");
      if (row.source_type === "note" && input.content !== undefined && !input.content.trim()) throw new KnowledgeError("INVALID_REQUEST", 400, "笔记正文不能为空");
      if (input.sourceUrl !== undefined && row.source_type !== "bookmark") throw new KnowledgeError("INVALID_REQUEST", 400, "仅书签可编辑地址");
      const revisionId = randomUUID();
      await client.query(`INSERT INTO rag_item_revisions
        (id,owner_id,item_id,object_id,revision_number,generation,mime,original_name,content,description,source_url,storage_status)
        SELECT $4,r.owner_id,r.item_id,r.object_id,
          (SELECT max(revision_number)+1 FROM rag_item_revisions WHERE owner_id=$1 AND item_id=$2),
          $5,r.mime,r.original_name,COALESCE($6,r.content),$7,COALESCE($8,r.source_url),'stored'
        FROM rag_item_revisions r WHERE r.owner_id=$1 AND r.item_id=$2 AND r.id=$3`,
      [owner, id, row.pending_revision_id ?? row.active_revision_id, revisionId, row.generation + 1, input.content ?? null, input.description, input.sourceUrl ?? null]);
      // Retain the active published version until a replacement is validated. Old pending work loses its generation.
      await client.query("UPDATE rag_item_revisions SET index_status='cancelled' WHERE owner_id=$1 AND item_id=$2 AND id=$3 AND id IS DISTINCT FROM $4", [owner, id, row.pending_revision_id, row.active_revision_id]);
      await client.query("UPDATE rag_items SET title=$3,version=version+1,generation=generation+1,pending_revision_id=$4,updated_at=now() WHERE owner_id=$1 AND id=$2", [owner, id, input.title, revisionId]);
      await client.query("DELETE FROM rag_item_tags WHERE owner_id=$1 AND item_id=$2", [owner, id]);
      for (const tag of input.tags) await client.query("INSERT INTO rag_item_tags (owner_id,item_id,tag) VALUES ($1,$2,$3)", [owner, id, tag]);
      await client.query("DELETE FROM rag_preview_tickets WHERE owner_id=$1 AND item_id=$2", [owner, id]);
      return { id, revisionId, version: row.version + 1 };
    });
  }

  async deleteCollection(owner: string, id: string, version: number) {
    return this.transaction(async (client) => {
      const current = await client.query("SELECT version FROM rag_collections WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [owner, id]);
      if (!current.rows[0]) throw notFound(); if (current.rows[0].version !== version) throw conflict();
      await client.query("UPDATE rag_collections SET deleted_at=now(),version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [owner, id]);
      const affected = await client.query("DELETE FROM rag_collection_items WHERE owner_id=$1 AND collection_id=$2 RETURNING item_id", [owner, id]);
      return { affectedItemIds: affected.rows.map((row) => row.item_id) };
    });
  }

  async deleteItem(owner: string, id: string, version: number) {
    return this.transaction(async (client) => {
      const item = await client.query("SELECT version FROM rag_items WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [owner, id]);
      if (!item.rows[0]) throw notFound(); if (item.rows[0].version !== version) throw conflict();
      const affected = await client.query("DELETE FROM rag_collection_items WHERE owner_id=$1 AND item_id=$2 RETURNING collection_id", [owner, id]);
      await client.query("UPDATE rag_items SET deleted_at=now(),version=version+1,generation=generation+1,active_revision_id=NULL,pending_revision_id=NULL WHERE owner_id=$1 AND id=$2", [owner, id]);
      await client.query("UPDATE rag_item_revisions SET index_status='cancelled' WHERE owner_id=$1 AND item_id=$2", [owner, id]);
      await client.query("DELETE FROM rag_preview_tickets WHERE owner_id=$1 AND item_id=$2", [owner, id]);
      // Retain immutable objects/revisions. Physical GC is separate and must check ALL references.
      return { affectedCollectionIds: affected.rows.map((row) => row.collection_id) };
    });
  }

  async getFile(owner: string, itemId: string, revisionId: string): Promise<KnowledgeFile> {
    const { rows } = await this.pool.query(`SELECT i.id,i.title,i.generation,r.id AS revision_id,r.mime,o.storage_key,o.byte_size
      FROM rag_items i JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id
      JOIN rag_objects o ON o.owner_id=r.owner_id AND o.id=r.object_id
      WHERE i.owner_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND r.id=$3 AND r.storage_status='stored'
        AND (i.pending_revision_id=r.id OR i.active_revision_id=r.id)`, [owner, itemId, revisionId]);
    const r = rows[0]; if (!r) throw notFound();
    return { itemId: r.id, revisionId: r.revision_id, generation: r.generation, key: r.storage_key, mime: r.mime, size: Number(r.byte_size), title: r.title };
  }

  async createPreviewTicket(owner: string, sessionToken: string, itemId: string, revisionId: string) {
    const file = await this.getFile(owner, itemId, revisionId);
    await this.pool.query("DELETE FROM rag_preview_tickets WHERE expires_at<=now()");
    const token = randomBytes(32).toString("base64url");
    const result = await this.pool.query(`INSERT INTO rag_preview_tickets (token_hash,owner_id,session_id,item_id,revision_id,generation,expires_at)
      SELECT $1,$2,s.id,$3,$4,$5,LEAST(s.expires_at,now()+interval '5 minutes') FROM sessions s
      WHERE s.user_id=$2 AND s.token_hash=$6 AND s.expires_at>now() RETURNING expires_at`,
    [digest(token), owner, itemId, revisionId, file.generation, digest(sessionToken)]);
    if (!result.rows.length) throw new KnowledgeError("UNAUTHORIZED", 401, "预览需要有效登录会话");
    return { token, expiresAt: result.rows[0].expires_at.toISOString() };
  }

  async resolvePreviewTicket(token: string): Promise<KnowledgeFile> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound();
    const { rows } = await this.pool.query(`SELECT t.owner_id,t.item_id,t.revision_id FROM rag_preview_tickets t
      JOIN sessions s ON s.id=t.session_id AND s.user_id=t.owner_id
      JOIN rag_items i ON i.owner_id=t.owner_id AND i.id=t.item_id AND i.generation=t.generation
      WHERE t.token_hash=$1 AND t.expires_at>now() AND s.expires_at>now() AND i.deleted_at IS NULL`, [digest(token)]);
    if (!rows[0]) throw notFound();
    return this.getFile(rows[0].owner_id, rows[0].item_id, rows[0].revision_id);
  }

  async storageUsage(owner: string): Promise<number> {
    const result = await this.pool.query("SELECT COALESCE(sum(byte_size),0) AS bytes FROM rag_objects WHERE owner_id=$1", [owner]);
    return Number(result.rows[0].bytes);
  }
}
