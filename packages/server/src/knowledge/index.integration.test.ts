import { afterAll, beforeAll, expect, it, describe, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { KnowledgeRepository } from "./repository.js";
import { KnowledgeJobs } from "./ingestion/jobs.js";
import { indexArtifact } from "./ingestion/indexer.js";
import { indexProfile } from "./ingestion/profile.js";
import { textBlocks } from "./ingestion/text.js";
import { PARSER_VERSION } from "./ingestion/version.js";
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
    return { item, lease: lease!, artifact: { blocks: textBlocks(content), diagnostics: [], parserVersion: PARSER_VERSION } };
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
