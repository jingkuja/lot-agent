import { afterAll, beforeAll, expect, it, describe, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { KnowledgeRepository } from "./repository.js";
import { KnowledgeJobs } from "./ingestion/jobs.js";
import { indexArtifact } from "./ingestion/indexer.js";
import { indexProfile } from "./ingestion/profile.js";
import { textBlocks } from "./ingestion/text.js";
import { PARSER_VERSION } from "./ingestion/version.js";
import type { ParsedArtifact } from "./ingestion/parsers.js";
import { KnowledgeRetriever } from "./retrieval.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import type { KnowledgeRetrievalRequest, KnowledgeReadScope } from "@lot-agent/core";

// SQL/state tests use deterministic vectors. The separate smoke script exercises TokenHub.
describe.skipIf(process.env.RAG_INTEGRATION !== "1")("published knowledge index", () => {
  let pool: pg.Pool; let repo: KnowledgeRepository; let jobs: KnowledgeJobs;
  const owner = randomUUID(); const other = randomUUID(); const queueName = `rag-index-${randomUUID()}`;
  const profile = indexProfile("https://fixture.invalid/v1");
  let collection: string; let second: string; let foreign: string;
  const vector = Array.from({ length: 1024 }, (_, n) => n === 0 ? 1 : 0);
  const embed = vi.fn(async () => ({ vector, tokens: 8 }));
  let retriever: KnowledgeRetriever;
  beforeAll(async () => {
    pool = new pg.Pool({ host: process.env.PG_HOST ?? "localhost", port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(pool, migrations);
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'rag index fixture'),($2,'rag foreign fixture')", [owner, other]);
    repo = new KnowledgeRepository(pool, queueName); jobs = new KnowledgeJobs(pool);
    collection = (await repo.createCollection(owner, { name: "测试一", description: "" }, randomUUID())).id;
    second = (await repo.createCollection(owner, { name: "测试二", description: "" }, randomUUID())).id;
    foreign = (await repo.createCollection(other, { name: "其他用户", description: "" }, randomUUID())).id;
    retriever = new KnowledgeRetriever(pool, profile, () => embed);
  });
  afterAll(async () => {
    try { await pool.query("DELETE FROM tasks WHERE user_id=ANY($1::text[])", [[owner, other]]); await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner, other]]); }
    finally { await pool?.end(); }
  });
  const request = (extra: Partial<KnowledgeRetrievalRequest> = {}): KnowledgeRetrievalRequest => ({ query: "离线查看", collectionIds: [collection, second], topK: 5, mode: "hybrid", sourceTypes: ["note"], tags: [], allowDegraded: false, ...extra });
  const scope = (req: KnowledgeRetrievalRequest): KnowledgeReadScope => ({ ownerId: owner, collectionIds: req.collectionIds, callerKind: "internal", permission: "retrieval:read" });
  const create = async (title: string, content: string, tags: string[] = []) => {
    const item = await repo.createItem(owner, { sourceType: "note", title, content, tags, description: "", collectionIds: [collection, second] }, randomUUID());
    const lease = await jobs.claim(item.taskId!, queueName);
    return { item, lease: lease!, artifact: { blocks: textBlocks(content), diagnostics: [], parserVersion: PARSER_VERSION } as ParsedArtifact };
  };
  it("publishes actual pgvector and Chinese FTS, with AND tags, OR types and deduplicated collections", async () => {
    const a = await create("AB-123 帮助", "离线查看资料 AB-123", ["手册", "产品"]);
    expect(await indexArtifact(jobs, a.lease, profile, a.artifact, embed)).toBe(true);
    const req = request({ tags: ["手册", "产品"] });
    const result = await retriever.retrieve(scope(req), req);
    expect(result.results).toHaveLength(1); expect(result.results[0].collectionIds).toHaveLength(2);
    expect(result.results[0].citation).toEqual({ kind: "text", startLine: 1, endLine: 1 });
    expect(result.results[0].score.kind).toBe("rrf");
    const filtered = request({ mode: "keyword", tags: ["手册", "不存在"] });
    expect((await retriever.retrieve(scope(filtered), filtered)).results).toHaveLength(0);
    const identifier = request({ mode: "keyword", query: "AB-123" });
    expect((await retriever.retrieve(scope(identifier), identifier)).results[0].itemId).toBe(a.item.id);
    await repo.changeMembership(owner, a.item.id, collection, false);
    const single = request({ collectionIds: [collection] });
    expect((await retriever.retrieve(scope(single), single)).results).toHaveLength(0);
  });
  it("denies cross-owner collections before model calls and permits only explicit keyword degradation", async () => {
    embed.mockClear(); const bad = request({ collectionIds: [foreign] });
    await expect(retriever.retrieve(scope(bad), bad)).rejects.toThrow("知识库不存在"); expect(embed).not.toHaveBeenCalled();
    const down = new KnowledgeRetriever(pool, profile, () => async () => { throw new Error("private key failure"); });
    const req = request(); await expect(down.retrieve(scope(req), req)).rejects.toThrow("查询向量暂不可用");
    const allowed = { ...req, allowDegraded: true }; const result = await down.retrieve(scope(allowed), allowed);
    expect(result.degraded).toBe(true); expect(result.modeUsed).toBe("keyword"); expect(result.warnings).toEqual(["QUERY_EMBEDDING_UNAVAILABLE"]);
  });
  it("retrieves terms across adjacent lines without a chunk per line", async () => {
    const item = await create("跨行型号", "AB-123\n支持离线查看");
    await indexArtifact(jobs, item.lease, profile, item.artifact, embed);
    const req = request({ query: "AB-123 离线查看", mode: "keyword" });
    const result = await retriever.retrieve(scope(req), req);
    expect(result.results.find((hit) => hit.itemId === item.item.id)?.citation).toEqual({ kind: "text", startLine: 1, endLine: 2 });
  });
  it("finds a filename-only identifier and a chapter title without rebuilding vectors", async () => {
    const a = await create("ZX-842 采购合同.pdf", "验收后十五天支付尾款。", ["metadata-test"]);
    a.artifact.blocks[0].citation = { kind: "docx", paragraph: 8, heading: "终止协议" };
    await indexArtifact(jobs, a.lease, profile, a.artifact, embed);
    for (const query of ["ZX-842", "请问 ZX-842 尾款什么时候支付？", "终止协议"]) {
      const req = request({ query, mode: "keyword", tags: ["metadata-test"] });
      const result = await retriever.retrieve(scope(req), req);
      expect(result.results[0]?.itemId, query).toBe(a.item.id);
      expect(result.results[0].content).toBe("验收后十五天支付尾款。");
    }
    const wrong = request({ query: "ZX-8420 尾款", mode: "keyword", tags: ["metadata-test"] });
    expect((await retriever.retrieve(scope(wrong), wrong)).results).toHaveLength(0);
    const missingTag = request({ query: "ZX-842", mode: "keyword", tags: ["absent"] });
    expect((await retriever.retrieve(scope(missingTag), missingTag)).results).toHaveLength(0);
    await repo.deleteItem(owner, a.item.id, 1);
    const deleted = request({ query: "ZX-842", mode: "keyword" });
    expect((await retriever.retrieve(scope(deleted), deleted)).results).toHaveLength(0);
  });
  it("retrieves content words in natural questions but preserves explicit identifiers", async () => {
    const a = await create("出行指南", "差旅报销提交发票和审批单。型号 AB-731。", ["natural-test"]);
    await indexArtifact(jobs, a.lease, profile, a.artifact, embed);
    const req = request({ query: "请问差旅报销需要哪些材料？", mode: "keyword", tags: ["natural-test"] });
    expect((await retriever.retrieve(scope(req), req)).results[0]?.itemId).toBe(a.item.id);
    const wrong = { ...req, query: "AB-732 差旅报销" };
    expect((await retriever.retrieve(scope(wrong), wrong)).results).toHaveLength(0);
    const punctuation = { ...req, query: "？请问一下" };
    expect((await retriever.retrieve(scope(punctuation), punctuation)).results).toHaveLength(0);
  });
  it("selects relevant body chunks within title matches instead of filling results with the start of a file", async () => {
    const a = await create("蓝鲸项目手册", "placeholder", ["long-title-test"]);
    a.artifact.blocks = Array.from({ length: 12 }, (_, index) => ({
      text: index === 10 ? "违约赔偿上限为合同金额的百分之十。" : `第${index}页为背景信息。`,
      origin: "extracted_text" as const, citation: { kind: "pdf" as const, page: index + 1 },
    }));
    await indexArtifact(jobs, a.lease, profile, a.artifact, embed);
    const req = request({ query: "蓝鲸项目手册的违约赔偿上限", mode: "keyword", tags: ["long-title-test"] });
    const result = await retriever.retrieve(scope(req), req);
    expect(result.results[0]?.citation).toEqual({ kind: "pdf", page: 11 });
  });
  it("optionally reads bounded neighbors with their own citations and no duplicate anchor text", async () => {
    const a = await create("上下文资料", "placeholder", ["neighbor-test"]);
    a.artifact.blocks = ["前提是先完成验收。", "付款期限为十五天。", "例外是有书面争议时暂停付款。"].map((text, n) => ({
      text, origin: "extracted_text" as const, citation: { kind: "pdf" as const, page: n + 1 },
    }));
    await indexArtifact(jobs, a.lease, profile, a.artifact, embed);
    const req = request({ query: "付款期限", mode: "keyword", topK: 1, tags: ["neighbor-test"] });
    const plain = await retriever.retrieve(scope(req), req);
    expect(plain.results).toHaveLength(1); expect(plain.results[0].context).toBeUndefined();
    const enriched = await retriever.retrieve(scope(req), req, undefined, { includeNeighbors: true });
    expect(enriched.results).toHaveLength(1);
    expect(enriched.results[0].citation).toEqual({ kind: "pdf", page: 2 });
    expect(enriched.results[0].content).toBe("付款期限为十五天。");
    expect(enriched.results[0].context?.map((c) => c.citation)).toEqual([{ kind: "pdf", page: 1 }, { kind: "pdf", page: 3 }]);
    expect(enriched.results[0].context?.every((c) => c.chunkId !== enriched.results[0].chunkId)).toBe(true);
    await expect(retriever.retrieve({ ...scope(req), callerKind: "session" }, req, undefined, { includeNeighbors: true })).rejects.toMatchObject({ status: 403 });
    const wrongType = { ...req, sourceTypes: ["document" as const] };
    expect((await retriever.retrieve(scope(wrongType), wrongType, undefined, { includeNeighbors: true })).results).toHaveLength(0);
    const racedPool = { query: async (sql: string, values: unknown[]) => {
      if (sql.includes("jsonb_to_recordset")) await repo.deleteItem(owner, a.item.id, 1);
      return pool.query(sql, values);
    } } as unknown as pg.Pool;
    const racing = new KnowledgeRetriever(racedPool, profile, () => embed);
    expect((await racing.retrieve(scope(req), req, undefined, { includeNeighbors: true })).results).toHaveLength(0);
  });
  it("does not reveal filename matches belonging to another owner or an unselected collection", async () => {
    const otherItem = await repo.createItem(other, { sourceType: "note", title: "FN-900 文件", content: "普通正文", description: "", tags: [], collectionIds: [foreign] }, randomUUID());
    await indexArtifact(jobs, (await jobs.claim(otherItem.taskId!, queueName))!, profile, { blocks: textBlocks("普通正文"), diagnostics: [], parserVersion: PARSER_VERSION }, embed);
    const mine = await create("FN-900 私有文件", "普通正文");
    await indexArtifact(jobs, mine.lease, profile, mine.artifact, embed);
    await repo.changeMembership(owner, mine.item.id, collection, false);
    const req = request({ query: "FN-900", mode: "keyword", collectionIds: [collection] });
    expect((await retriever.retrieve(scope(req), req, undefined, { includeNeighbors: true })).results).toHaveLength(0);
  });
  it("does not double-count weak title and body overlaps ahead of a relevant semantic hit", async () => {
    const relevant = await create("离线指南", "下载后断网也能阅读。", ["fusion-test"]);
    const distractor = await create("网络资料", "网络设备资料保留三十天。", ["fusion-test"]);
    await indexArtifact(jobs, relevant.lease, profile, relevant.artifact, embed);
    const tilted = vector.map((_, n) => n === 0 ? 0.7 : n === 1 ? Math.sqrt(0.51) : 0);
    await indexArtifact(jobs, distractor.lease, profile, distractor.artifact, async () => ({ vector: tilted, tokens: 8 }));
    const req = request({ query: "网络断开后怎样查看资料？", mode: "hybrid", tags: ["fusion-test"] });
    expect((await retriever.retrieve(scope(req), req)).results[0]?.itemId).toBe(relevant.item.id);
  });
  it("uses an explicitly named file even when its body ranks below the semantic top five", async () => {
    for (let n = 0; n < 6; n++) {
      const noise = await create(`背景资料${n}`, "这是无关的背景介绍。", ["named-file-test"]);
      await indexArtifact(jobs, noise.lease, profile, noise.artifact, embed);
    }
    const target = await create("紫藤项目合同.pdf", "验收后十五日支付余款。", ["named-file-test"]);
    await indexArtifact(jobs, target.lease, profile, target.artifact, async () => ({ vector: vector.map((_, n) => n === 1 ? 1 : 0), tokens: 8 }));
    const req = request({ query: "紫藤项目合同的付款条件", mode: "semantic", topK: 5, tags: ["named-file-test"] });
    expect((await retriever.retrieve(scope(req), req)).results.some((row) => row.itemId === target.item.id)).toBe(false);
    const hybrid = { ...req, mode: "hybrid" as const };
    expect((await retriever.retrieve(scope(hybrid), hybrid)).results[0]?.itemId).toBe(target.item.id);
  });
  it("rejects bad dimensions and actual usage above budget without publishing", async () => {
    const item = await create("invalid", "invalid body");
    await expect(indexArtifact(jobs, item.lease, profile, item.artifact, async () => ({ vector: [1], tokens: 2 }))).rejects.toThrow("INVALID_EMBEDDING_RESPONSE");
    await expect(indexArtifact(jobs, item.lease, profile, item.artifact, async () => ({ vector, tokens: 513 }))).rejects.toThrow("EMBEDDING_TOKEN_BUDGET_EXCEEDED");
    const state = await pool.query("SELECT active_revision_id FROM rag_items WHERE id=$1", [item.item.id]); expect(state.rows[0].active_revision_id).toBeNull();
  });
  it("reuses completed vectors on retry and never resurrects a deleted item", async () => {
    const a = await create("retry", "a".repeat(300) + "\n" + "b".repeat(300)); let calls = 0;
    await expect(indexArtifact(jobs, a.lease, profile, a.artifact, async () => { if (++calls === 2) throw new Error("TRANSIENT"); return { vector, tokens: 2 }; })).rejects.toThrow("TRANSIENT");
    await jobs.fail(a.lease, "TRANSIENT", false);
    const retried = await jobs.retry(owner, a.item.id, 1, queueName);
    const next = (await jobs.claim(retried.taskId, queueName))!;
    const remaining = vi.fn(async () => ({ vector, tokens: 2 }));
    expect(await indexArtifact(jobs, next, profile, a.artifact, remaining)).toBe(true); expect(remaining).toHaveBeenCalledTimes(1);
    const b = await create("delete race", "not visible");
    const deleted = await indexArtifact(jobs, b.lease, profile, b.artifact, async () => { await repo.deleteItem(owner, b.item.id, 1); return { vector, tokens: 2 }; }).catch((error) => error.message);
    expect(deleted).toBe("INGESTION_CANCELLED");
    expect((await pool.query("SELECT 1 FROM rag_chunks WHERE item_id=$1", [b.item.id])).rows).toHaveLength(0);
  });
  it("rechecks item visibility after query embedding and refuses mixed index profiles", async () => {
    const a = await create("visibility", "visibility unique"); await indexArtifact(jobs, a.lease, profile, a.artifact, embed);
    const racing = new KnowledgeRetriever(pool, profile, () => async () => { await repo.deleteItem(owner, a.item.id, 1); return { vector, tokens: 1 }; });
    const req = request({ mode: "semantic" }); expect((await racing.retrieve(scope(req), req)).results.some((row) => row.itemId === a.item.id)).toBe(false);
    const changed = new KnowledgeRetriever(pool, indexProfile("https://new-route.invalid/v1"), () => embed);
    expect((await changed.retrieve(scope(req), req)).modeUsed).toBe("semantic"); // Owner profile stays pinned until explicit cutover.
  });
});
