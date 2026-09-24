import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { KnowledgeReadScope, MemoryExtraction } from "@lot-agent/core";
import { KnowledgeRepository } from "../repository.js";
import { KnowledgeError } from "../errors.js";
import { prepareIngestion, supersedeIngestion } from "../ingestion/prepare.js";
import { canonicalFactKey, factInput, factText, type FactInput } from "./values.js";
const current = "active AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>now())";

export class KnowledgeFacts {
  constructor(readonly pool: Pool, readonly queueName?: string) {}
  async list(owner: string, includeInactive = true) {
    const { rows } = await this.pool.query(`SELECT f.*,(${current}) AS current,
      ARRAY(SELECT ci.collection_id FROM rag_collection_items ci JOIN rag_collections c ON c.owner_id=ci.owner_id AND c.id=ci.collection_id WHERE ci.owner_id=f.owner_id AND ci.item_id=f.item_id AND c.deleted_at IS NULL ORDER BY ci.collection_id) AS collection_ids
      FROM rag_profile_facts f WHERE owner_id=$1 ${includeInactive ? "" : `AND ${current}`} ORDER BY updated_at DESC,id DESC`, [owner]);
    return rows;
  }
  async exact(scope: KnowledgeReadScope, keys: string[]) {
    if (scope.permission !== "profile:read") throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "个人信息授权范围不足");
    const { rows } = await this.pool.query(`SELECT key,value,value_type,category,version FROM rag_profile_facts WHERE owner_id=$1 AND key=ANY($2::text[]) AND ${current}
      AND ($3::boolean=false OR share_with_api)`, [scope.ownerId, keys.map(canonicalFactKey), scope.callerKind === "access_key"]);
    return rows;
  }
  async history(owner: string, id: string) {
    return (await this.pool.query("SELECT version,snapshot,created_at FROM rag_profile_history WHERE owner_id=$1 AND fact_id=$2 ORDER BY version DESC", [owner, id])).rows;
  }
  async save(owner: string, raw: unknown) {
    const input = factInput.parse(raw);
    return new KnowledgeRepository(this.pool).transaction((client) => this.saveIn(client, owner, input, "manual"));
  }
  private async saveIn(client: PoolClient, owner: string, input: FactInput, source: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`fact:${owner}:${input.key}`]);
    const old = (await client.query("SELECT * FROM rag_profile_facts WHERE owner_id=$1 AND key=$2 FOR UPDATE", [owner, input.key])).rows[0];
    if ((old?.version ?? 0) !== input.version) throw new KnowledgeError("CONFLICT", 409, "个人信息已更新，请刷新后重试");
    const collections = await client.query("SELECT id FROM rag_collections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE", [owner, input.collectionIds]);
    if (collections.rows.length !== input.collectionIds.length) throw new KnowledgeError("NOT_FOUND", 404, "知识库不存在");
    const itemId = old?.item_id ?? randomUUID(); const revisionId = randomUUID(); const factId = old?.id ?? randomUUID();
    let generation = 1;
    if (old) {
      const item = (await client.query("SELECT generation FROM rag_items WHERE owner_id=$1 AND id=$2 FOR UPDATE", [owner, itemId])).rows[0];
      generation = item.generation + 1;
      await supersedeIngestion(client, owner, itemId);
      await client.query("UPDATE rag_item_revisions SET index_status='cancelled' WHERE owner_id=$1 AND item_id=$2 AND index_status IN ('pending','processing')", [owner, itemId]);
      // Confirmed facts differ from documents: an old value must disappear immediately.
      await client.query("UPDATE rag_items SET active_revision_id=NULL,pending_revision_id=$3,generation=$4,version=version+1,deleted_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2", [owner, itemId, revisionId, generation]);
      await client.query("DELETE FROM rag_preview_tickets WHERE owner_id=$1 AND item_id=$2", [owner, itemId]);
    } else await client.query("INSERT INTO rag_items(id,owner_id,source_type,title,pending_revision_id) VALUES ($1,$2,'profile_fact',$3,$4)", [itemId, owner, input.key, revisionId]);
    await client.query(`INSERT INTO rag_item_revisions(id,owner_id,item_id,revision_number,generation,mime,content,storage_status,index_status)
      VALUES ($1,$2,$3,$4,$4,'text/plain',$5,'stored',$6)`, [revisionId, owner, itemId, generation, `${input.key}: ${factText(input.value)}`, input.active ? "pending" : "cancelled"]);
    await client.query(`INSERT INTO rag_profile_facts(id,owner_id,key,value,value_type,category,source,active,valid_from,valid_until,share_with_api,version,item_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(owner_id,key) DO UPDATE SET value=EXCLUDED.value,value_type=EXCLUDED.value_type,category=EXCLUDED.category,source=EXCLUDED.source,
      active=EXCLUDED.active,valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,share_with_api=EXCLUDED.share_with_api,version=EXCLUDED.version,updated_at=now()`,
    [factId, owner, input.key, JSON.stringify(input.value), input.type, input.category, source, input.active, input.validFrom, input.validUntil, input.shareWithApi, input.version + 1, itemId]);
    await client.query("INSERT INTO rag_profile_history(owner_id,fact_id,version,snapshot) SELECT owner_id,id,version,to_jsonb(f) FROM rag_profile_facts f WHERE owner_id=$1 AND id=$2", [owner, factId]);
    await client.query("DELETE FROM rag_collection_items WHERE owner_id=$1 AND item_id=$2", [owner, itemId]);
    for (const collection of input.collectionIds) await client.query("INSERT INTO rag_collection_items(owner_id,collection_id,item_id) VALUES ($1,$2,$3)", [owner, collection, itemId]);
    const taskId = input.active && this.queueName ? await prepareIngestion(client, { ownerId: owner, itemId, revisionId, generation, queueName: this.queueName }) : undefined;
    return { id: factId, itemId, revisionId, version: input.version + 1, ...(taskId ? { taskId } : {}) };
  }
  async suggest(owner: string, extraction: MemoryExtraction, sourceId?: string) {
    return new KnowledgeRepository(this.pool).transaction(async (client) => {
      for (const candidate of [...extraction.upserts.map((row) => ({ ...row, operation: "set" })), ...extraction.deletes.map((key) => ({ key, value: null, operation: "delete" }))]) {
        const key = canonicalFactKey(candidate.key);
        if (!/^[a-z][a-z0-9_]{0,99}$/.test(key) || (candidate.value !== null && candidate.value.length > 5000)) continue;
        await client.query(`INSERT INTO rag_profile_candidates(owner_id,key,value,operation,source,source_id) VALUES ($1,$2,$3,$4,'memory.extract',$5)
          ON CONFLICT(owner_id,source_id,key,operation) DO NOTHING`, [owner, key, JSON.stringify(candidate.value), candidate.operation, sourceId ?? randomUUID()]);
      }
    });
  }
  async candidates(owner: string, before?: string) {
    return (await this.pool.query("SELECT * FROM rag_profile_candidates WHERE owner_id=$1 AND status='pending' AND ($2::timestamptz IS NULL OR created_at<$2) ORDER BY created_at DESC,id DESC LIMIT 100", [owner, before ?? null])).rows;
  }
  async resolve(owner: string, id: string, accept: boolean, expectedVersion: number) {
    return new KnowledgeRepository(this.pool).transaction(async (client) => {
      const candidate = (await client.query("SELECT * FROM rag_profile_candidates WHERE owner_id=$1 AND id=$2 FOR UPDATE", [owner, id])).rows[0];
      if (!candidate) throw new KnowledgeError("NOT_FOUND", 404, "候选不存在");
      if (candidate.status !== "pending") throw new KnowledgeError("CONFLICT", 409, "候选已处理");
      let result;
      if (accept) {
        const old = (await client.query("SELECT * FROM rag_profile_facts WHERE owner_id=$1 AND key=$2", [owner, candidate.key])).rows[0];
        const memberships = old ? (await client.query("SELECT collection_id FROM rag_collection_items WHERE owner_id=$1 AND item_id=$2", [owner, old.item_id])).rows.map((r) => r.collection_id) : [];
        result = await this.saveIn(client, owner, factInput.parse({ key: candidate.key, value: candidate.operation === "delete" ? old?.value ?? "已停用" : candidate.value,
          type: candidate.operation === "delete" ? old?.value_type ?? "text" : "text", category: old?.category ?? "个人信息", active: candidate.operation !== "delete",
          shareWithApi: old?.share_with_api ?? false, validFrom: old?.valid_from?.toISOString() ?? null, validUntil: old?.valid_until?.toISOString() ?? null, version: expectedVersion, collectionIds: memberships }), "confirmed_candidate");
      }
      await client.query("UPDATE rag_profile_candidates SET status=$3,resolved_at=now() WHERE owner_id=$1 AND id=$2", [owner, id, accept ? "accepted" : "rejected"]);
      return result ?? { id, status: "rejected" };
    });
  }
}
