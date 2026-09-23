import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { KnowledgeReadScope, KnowledgeRetrievalRequest, KnowledgeRetrievalResult, KnowledgeEvidence } from "@lot-agent/core";
import { KnowledgeError } from "./errors.js";
import { lexicalText, type IndexProfile } from "./ingestion/profile.js";
import type { EmbedOne } from "./ingestion/indexer.js";

type Ranked = { id: string; value: number };
export function fuseRanks(lists: Ranked[][]): Ranked[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((entry, index) => {
      if (seen.has(entry.id)) return; seen.add(entry.id);
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1 / (60 + index + 1));
    });
  }
  return [...scores].map(([id, value]) => ({ id, value })).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
}
// Every candidate and final read applies these predicates before returning any content.
const scoped = `FROM rag_chunks ch JOIN rag_items i ON i.owner_id=ch.owner_id AND i.id=ch.item_id
  JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=ch.revision_id
  WHERE ch.owner_id=$1 AND i.deleted_at IS NULL AND i.active_revision_id=ch.revision_id AND r.index_status='ready'
    AND i.source_type=ANY($3::text[]) AND ch.profile_id=$5
    AND EXISTS (SELECT 1 FROM rag_collection_items ci JOIN rag_collections co ON co.owner_id=ci.owner_id AND co.id=ci.collection_id
      WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND co.deleted_at IS NULL AND ci.collection_id=ANY($2::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM unnest($4::text[]) wanted(tag) WHERE NOT EXISTS
      (SELECT 1 FROM rag_item_tags t WHERE t.owner_id=i.owner_id AND t.item_id=i.id AND t.tag=wanted.tag))`;

export class KnowledgeRetriever {
  constructor(readonly pool: Pool, readonly profile: IndexProfile, readonly embedFor: (ownerId: string) => EmbedOne) {}
  async retrieve(scope: KnowledgeReadScope, request: KnowledgeRetrievalRequest): Promise<KnowledgeRetrievalResult> {
    if (scope.permission !== "retrieval:read" || request.collectionIds.length !== scope.collectionIds.length || request.collectionIds.some((id) => !scope.collectionIds.includes(id))) throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "检索范围无效");
    // S3 access keys require fresh grant revalidation; this S2 endpoint is session/internal only.
    if (scope.callerKind === "access_key") throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "外部知识授权尚未开放");
    const checkScope = async () => {
      const owned = await this.pool.query("SELECT id FROM rag_collections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL", [scope.ownerId, scope.collectionIds]);
      if (owned.rows.length !== scope.collectionIds.length) throw new KnowledgeError("NOT_FOUND", 404, "知识库不存在或不可见");
    };
    await checkScope();
    const mismatch = await this.pool.query(`SELECT 1 FROM rag_items i JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=i.active_revision_id
      WHERE i.owner_id=$1 AND i.deleted_at IS NULL AND r.index_status='ready' AND r.index_profile_id IS DISTINCT FROM $3
      AND EXISTS (SELECT 1 FROM rag_collection_items ci WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND ci.collection_id=ANY($2::uuid[])) LIMIT 1`, [scope.ownerId, scope.collectionIds, this.profile.id]);
    if (mismatch.rows.length) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "索引规则已变化，需要重建后检索");
    const params = [scope.ownerId, scope.collectionIds, request.sourceTypes, request.tags, this.profile.id];
    let mode = request.mode; const warnings: string[] = []; let vector: number[] | undefined;
    if (mode !== "keyword") {
      try { vector = (await this.embedFor(scope.ownerId)(request.query)).vector; }
      catch {
        if (!request.allowDegraded) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "查询向量暂不可用", true);
        mode = "keyword"; warnings.push("QUERY_EMBEDDING_UNAVAILABLE");
      }
    }
    let keyword: Ranked[] = []; let semantic: Ranked[] = [];
    if (mode !== "semantic") {
      const { rows } = await this.pool.query(`SELECT ch.id,ts_rank_cd(ch.lexical,plainto_tsquery('simple',$6)) AS value ${scoped}
        AND ch.lexical @@ plainto_tsquery('simple',$6) ORDER BY value DESC,ch.id LIMIT 30`, [...params, lexicalText(request.query)]);
      keyword = rows.map((row) => ({ id: row.id, value: Number(row.value) }));
    }
    if (mode !== "keyword") {
      if (!vector || vector.length !== this.profile.dimensions || !vector.every(Number.isFinite) || !vector.some((n) => n !== 0)) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "查询向量无效");
      const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
      if (!Number.isFinite(norm) || norm <= 0) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "查询向量无效");
      vector = vector.map((value) => value / norm);
      const { rows } = await this.pool.query(`SELECT ch.id,1-(ch.embedding OPERATOR(public.<=>) $6::public.vector) AS value ${scoped}
        ORDER BY ch.embedding OPERATOR(public.<=>) $6::public.vector,ch.id LIMIT 30`, [...params, JSON.stringify(vector)]);
      semantic = rows.map((row) => ({ id: row.id, value: Number(row.value) }));
    }
    const ranked = mode === "hybrid" ? fuseRanks([keyword, semantic]) : mode === "keyword" ? keyword : semantic;
    await checkScope();
    // Re-read after the model call and candidate queries: deletes, replacements, tags and membership changes take effect here.
    const { rows } = await this.pool.query(`SELECT ch.id,ch.item_id,ch.revision_id,ch.content,ch.origin,ch.citation,i.title,i.source_type,
      ARRAY(SELECT ci.collection_id FROM rag_collection_items ci JOIN rag_collections co ON co.owner_id=ci.owner_id AND co.id=ci.collection_id
        WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND ci.collection_id=ANY($2::uuid[]) AND co.deleted_at IS NULL ORDER BY ci.collection_id) AS collection_ids
      ${scoped} AND ch.id=ANY($6::uuid[])`, [...params, ranked.map((entry) => entry.id)]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const results: KnowledgeEvidence[] = ranked.flatMap((score) => {
      const row = byId.get(score.id); if (!row) return [];
      return [{ itemId: row.item_id, revisionId: row.revision_id, chunkId: row.id, collectionIds: row.collection_ids,
        title: row.title, content: row.content, sourceType: row.source_type, origin: row.origin,
        score: { kind: mode === "hybrid" ? "rrf" as const : mode === "keyword" ? "ts_rank_cd" as const : "cosine" as const, value: score.value },
        ...(row.citation ? { citation: row.citation } : {}) }];
    }).slice(0, request.topK);
    return { requestId: randomUUID(), modeUsed: mode, degraded: mode !== request.mode, results, warnings };
  }
}
