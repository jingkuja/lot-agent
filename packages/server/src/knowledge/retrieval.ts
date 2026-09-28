import { activeProfile, spaceFor } from "./ingestion/spaces.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { KnowledgeReadScope, KnowledgeRetrievalRequest, KnowledgeRetrievalResult, KnowledgeEvidence } from "@lot-agent/core";
import { KnowledgeError } from "./errors.js";
import { lexicalText, type IndexProfile } from "./ingestion/profile.js";
import type { EmbedOne } from "./ingestion/indexer.js";
import { retrievalQuery } from "./retrieval-query.js";

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
const scoped = (table: string, external = false) => `FROM ${table} ch JOIN rag_items i ON i.owner_id=ch.owner_id AND i.id=ch.item_id
  JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=ch.revision_id
  WHERE ch.owner_id=$1 AND i.deleted_at IS NULL AND i.active_revision_id=ch.revision_id AND r.index_status='ready'
    AND (i.source_type<>'profile_fact' OR EXISTS (SELECT 1 FROM rag_profile_facts f WHERE f.owner_id=i.owner_id AND f.item_id=i.id
      AND ${external ? 'f.share_with_api AND' : ''} f.active AND (f.valid_from IS NULL OR f.valid_from<=now()) AND (f.valid_until IS NULL OR f.valid_until>now())))
    AND i.source_type=ANY($3::text[]) AND ch.profile_id=$5
    AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM rag_collection_items ci JOIN rag_collections co ON co.owner_id=ci.owner_id AND co.id=ci.collection_id
      WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND co.deleted_at IS NULL AND ci.collection_id=ANY($2::uuid[])))
    AND NOT EXISTS (SELECT 1 FROM unnest($4::text[]) wanted(tag) WHERE NOT EXISTS
      (SELECT 1 FROM rag_item_tags t WHERE t.owner_id=i.owner_id AND t.item_id=i.id AND t.tag=wanted.tag))`;

export class KnowledgeRetriever {
  constructor(readonly pool: Pool, readonly profile: IndexProfile, readonly embedFor: (ownerId: string, profile: IndexProfile, scope?: KnowledgeReadScope) => EmbedOne, readonly authorize?: (scope: KnowledgeReadScope, request: KnowledgeRetrievalRequest) => Promise<void>) {}
  async retrieve(scope: KnowledgeReadScope, request: KnowledgeRetrievalRequest, signal?: AbortSignal, options?: { includeNeighbors?: boolean }): Promise<KnowledgeRetrievalResult> {
    if (options?.includeNeighbors && scope.callerKind !== "internal") throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "上下文读取范围无效");
    if (scope.permission !== "retrieval:read" || request.collectionIds.length !== scope.collectionIds.length || request.collectionIds.some((id) => !scope.collectionIds.includes(id))) throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "检索范围无效");
    // External keys are revalidated before model execution and again before results are read.
    if (scope.callerKind === "access_key" && !this.authorize) throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "外部知识授权尚未开放");
    if (scope.allOwned && (scope.callerKind !== "internal" || scope.collectionIds.length)) throw new KnowledgeError("SCOPE_FORBIDDEN", 403, "全局搜索范围无效");
    const checkScope = async () => {
      if (signal?.aborted) throw new KnowledgeError("REQUEST_TIMEOUT", 504, "检索超时", true);
      if (scope.callerKind === "access_key") await this.authorize!(scope, request);
      if (scope.allOwned) return;
      const owned = await this.pool.query("SELECT id FROM rag_collections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL", [scope.ownerId, scope.collectionIds]);
      if (owned.rows.length !== scope.collectionIds.length) throw new KnowledgeError("NOT_FOUND", 404, "知识库不存在或不可见");
    };
    await checkScope();
    const profile = await activeProfile(this.pool, scope.ownerId, this.profile);
    if (profile.dictionaryVersion !== this.profile.dictionaryVersion) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "分词版本变化，需要重建索引");
    const table = await spaceFor(this.pool, profile);
    const mismatch = await this.pool.query(`SELECT 1 FROM rag_items i JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=i.active_revision_id
      WHERE i.owner_id=$1 AND i.deleted_at IS NULL AND r.index_status='ready' AND NOT EXISTS(SELECT 1 FROM rag_revision_indexes ix WHERE ix.owner_id=i.owner_id AND ix.revision_id=i.active_revision_id AND ix.profile_id=$3)
      AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM rag_collection_items ci WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND ci.collection_id=ANY($2::uuid[]))) LIMIT 1`, [scope.ownerId, scope.allOwned ? null : scope.collectionIds, profile.id]);
    if (mismatch.rows.length) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "索引规则已变化，需要重建后检索");
    const params = [scope.ownerId, scope.allOwned ? null : scope.collectionIds, request.sourceTypes, request.tags, profile.id];
    let mode = request.mode; const warnings: string[] = []; let vector: number[] | undefined;
    if (mode !== "keyword") {
      try {
        const embedded = await this.embedFor(scope.ownerId, profile, scope)(request.query, signal);
        // No tokenizer endpoint: enforce the real provider usage after the metered call.
        if (!Number.isInteger(embedded.tokens) || embedded.tokens <= 0 || embedded.tokens > 2048) throw new KnowledgeError("INVALID_REQUEST", 400, "查询超过 2048 token 限制，请缩短问题");
        vector = embedded.vector;
      }
      catch (error) {
        if (error instanceof KnowledgeError) throw error;
        if (signal?.aborted) throw new KnowledgeError("REQUEST_TIMEOUT", 504, "检索超时", true);
        if (error instanceof Error && error.message === "EMBEDDING_QUOTA_EXCEEDED") throw new KnowledgeError("QUOTA_EXCEEDED", 402, "知识库所有者额度不足");
        if (!request.allowDegraded) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "查询向量暂不可用", true);
        mode = "keyword"; warnings.push("QUERY_EMBEDDING_UNAVAILABLE");
      }
    }
    let keyword: Ranked[] = []; let semantic: Ranked[] = []; let metadata: Ranked[] = [];
    let strongKeyword: Ranked[] = []; let strongMetadata: Ranked[] = [];
    if (mode !== "keyword") {
      if (!vector || vector.length !== profile.dimensions || !vector.every(Number.isFinite) || !vector.some((n) => n !== 0)) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "查询向量无效");
      const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
      if (!Number.isFinite(norm) || norm <= 0) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "查询向量无效");
      vector = vector.map((value) => value / norm);
      const { rows } = await this.pool.query(`SELECT ch.id,1-(ch.embedding OPERATOR(public.<=>) $6::public.vector) AS value ${scoped(table, scope.callerKind === "access_key")}
        ORDER BY ch.embedding OPERATOR(public.<=>) $6::public.vector,ch.id LIMIT 30`, [...params, JSON.stringify(vector)]);
      semantic = rows.map((row) => ({ id: row.id, value: Number(row.value) }));
    }
    if (mode !== "semantic") {
      const query = retrievalQuery(request.query);
      if (query.terms.length) {
        // plainto_tsquery quotes each term before composing OR; user input is never SQL/tsquery syntax.
        const search = `WITH search AS (SELECT plainto_tsquery('simple',$6) AS strict,
          (SELECT string_agg('('||q::text||')',' | ')::tsquery FROM
            (SELECT plainto_tsquery('simple',term) AS q FROM unnest($7::text[]) term) words WHERE q::text<>'') AS relaxed)`;
        const title = `lower(normalize(i.title,NFKC))`;
        const heading = `lower(normalize(COALESCE(ch.citation->>'heading',''),NFKC))`;
        const titleStem = `regexp_replace(${title},'\\.[a-z0-9]{1,8}$','')`;
        // Exact IDs may live in the title while the queried condition lives in the body.
        const identifiers = `AND NOT EXISTS (SELECT 1 FROM unnest($8::text[],$9::text[]) required(term,pattern)
          WHERE NOT (ch.lexical @@ plainto_tsquery('simple',required.term) OR ${title} ~ required.pattern OR ${heading} ~ required.pattern))`;
        const values = [...params, lexicalText(request.query), query.terms, query.identifiers, query.identifierPatterns];
        const [body, meta] = await Promise.all([
          this.pool.query(`${search} SELECT ch.id,ts_rank_cd(ch.lexical,(SELECT relaxed FROM search)) AS value,
            (ch.lexical @@ (SELECT strict FROM search)) AS strong_match
            ${scoped(table, scope.callerKind === "access_key")}
            AND ch.lexical @@ (SELECT relaxed FROM search) ${identifiers}
            ORDER BY strong_match DESC,value DESC,ch.id LIMIT 30`, values),
          this.pool.query(`${search}, candidates AS (
            SELECT ch.id,ch.item_id,ch.ordinal,
              ts_rank_cd(ch.lexical,(SELECT relaxed FROM search)) AS body_score,
              array_position($10::uuid[],ch.id) AS semantic_rank,
              ((length(${titleStem})>=2 AND strpos($11,${titleStem})>0)
                OR (length(${heading})>=2 AND strpos($11,${heading})>0)
                OR NOT EXISTS (SELECT 1 FROM unnest($7::text[]) term WHERE strpos(${title},term)=0 AND strpos(${heading},term)=0)
                OR (EXISTS (SELECT 1 FROM unnest($8::text[]) term WHERE term ~ '[a-z]')
                  AND NOT EXISTS (SELECT 1 FROM unnest($8::text[],$9::text[]) required(term,pattern)
                    WHERE required.term ~ '[a-z]' AND NOT (${title} ~ required.pattern OR ${heading} ~ required.pattern)))) AS strong_match,
              (SELECT count(*) FROM unnest($7::text[]) term WHERE strpos(${title},term)>0 OR strpos(${heading},term)>0) AS value
            ${scoped(table, scope.callerKind === "access_key")}
            AND EXISTS (SELECT 1 FROM unnest($7::text[]) term WHERE strpos(${title},term)>0 OR strpos(${heading},term)>0)
            ${identifiers}
          ), limited AS (SELECT *,row_number() OVER (PARTITION BY item_id ORDER BY strong_match DESC,value DESC,body_score DESC,semantic_rank NULLS LAST,ordinal,id) AS item_rank FROM candidates)
          SELECT id,value,strong_match FROM limited WHERE item_rank<=3 ORDER BY strong_match DESC,value DESC,body_score DESC,semantic_rank NULLS LAST,ordinal,id LIMIT 30`, [...values, semantic.map((row) => row.id), request.query.normalize("NFKC").toLowerCase()]),
        ]);
        keyword = body.rows.map((row) => ({ id: row.id, value: Number(row.value) }));
        metadata = meta.rows.map((row) => ({ id: row.id, value: Number(row.value) }));
        strongKeyword = body.rows.filter((row) => row.strong_match).map((row) => ({ id: row.id, value: Number(row.value) }));
        strongMetadata = meta.rows.filter((row) => row.strong_match).map((row) => ({ id: row.id, value: Number(row.value) }));
      }
    }
    const fused = mode === "hybrid" || mode === "keyword" && metadata.length > 0;
    // Partial word/title matches are useful in keyword mode, but treating them as a second and
    // third independent vote drowns out semantic relevance. Fuse strong lexical signals once.
    const ranked = mode === "hybrid" ? fuseRanks([fuseRanks([strongKeyword, strongMetadata]), semantic])
      : fused ? fuseRanks([keyword, metadata]) : mode === "keyword" ? keyword : semantic;
    await checkScope();
    if ((await activeProfile(this.pool, scope.ownerId, this.profile)).id !== profile.id) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "索引已切换，请重新检索", true);
    // Re-read after the model call and candidate queries: deletes, replacements, tags and membership changes take effect here.
    const { rows } = await this.pool.query(`SELECT ch.id,ch.item_id,ch.revision_id,ch.ordinal,ch.content,ch.origin,ch.citation,i.title,i.source_type,
      ARRAY(SELECT ci.collection_id FROM rag_collection_items ci JOIN rag_collections co ON co.owner_id=ci.owner_id AND co.id=ci.collection_id
        WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND ($2::uuid[] IS NULL OR ci.collection_id=ANY($2::uuid[])) AND co.deleted_at IS NULL ORDER BY ci.collection_id) AS collection_ids
      ${scoped(table, scope.callerKind === "access_key")} AND ch.id=ANY($6::uuid[])`, [...params, ranked.map((entry) => entry.id)]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    let results: KnowledgeEvidence[] = ranked.flatMap((score) => {
      const row = byId.get(score.id); if (!row) return [];
      return [{ itemId: row.item_id, revisionId: row.revision_id, chunkId: row.id, collectionIds: row.collection_ids,
        title: row.title, content: row.content, sourceType: row.source_type, origin: row.origin,
        score: { kind: fused ? "rrf" as const : mode === "keyword" ? "ts_rank_cd" as const : "cosine" as const, value: score.value },
        ...(row.citation ? { citation: row.citation } : {}) }];
    }).slice(0, request.topK);
    if (options?.includeNeighbors && results.length) {
      // A separate scoped read preserves genuine page/paragraph locators and the anchor's original text.
      const anchors = results.map((result) => byId.get(result.chunkId)!);
      const neighbors = await this.pool.query(`SELECT ch.id,ch.item_id,ch.revision_id,ch.ordinal,ch.content,ch.origin,ch.citation
        ${scoped(table, scope.callerKind === "access_key")}
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($6::jsonb) AS anchor(item_id uuid,revision_id uuid,ordinal int)
          WHERE anchor.item_id=ch.item_id AND anchor.revision_id=ch.revision_id AND abs(anchor.ordinal-ch.ordinal)<=1)
        ORDER BY ch.item_id,ch.ordinal,ch.id`, [...params, JSON.stringify(anchors.map(({ item_id, revision_id, ordinal }) => ({ item_id, revision_id, ordinal })))]);
      // Removal/replacement during this additional read must invalidate the anchor as well.
      const stillVisible = new Set(neighbors.rows.map((row) => row.id));
      results = results.filter((result) => stillVisible.has(result.chunkId));
      const seen = new Set(results.map((result) => result.chunkId)); let remaining = 10;
      for (const result of results) {
        const anchor = byId.get(result.chunkId)!;
        const context: NonNullable<KnowledgeEvidence["context"]> = [];
        for (const row of neighbors.rows) {
          if (!remaining || seen.has(row.id) || row.item_id !== result.itemId || row.revision_id !== result.revisionId || Math.abs(row.ordinal - anchor.ordinal) !== 1) continue;
          seen.add(row.id); remaining--;
          context.push({ chunkId: row.id, content: row.content, origin: row.origin,
            position: row.ordinal < anchor.ordinal ? "before" : "after", ...(row.citation ? { citation: row.citation } : {}) });
        }
        if (context.length) result.context = context;
      }
    }
    if ((await activeProfile(this.pool, scope.ownerId, this.profile)).id !== profile.id) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "索引已切换，请重新检索", true);
    await checkScope();
    return { requestId: randomUUID(), modeUsed: mode, degraded: mode !== request.mode, results, warnings };
  }
}
