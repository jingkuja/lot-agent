import { Hono } from "hono";
import { createKnowledgeManageRoutes } from "./routes.js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import pg from "pg";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { KnowledgeRepository } from "./repository.js";
import { LocalKnowledgeStorage } from "./private-storage.js";
import { KnowledgeMaterials } from "./materials.js";
import { collectKnowledgeGarbage } from "./garbage-collector.js";
import { withKnowledgeStorageLease } from "./storage-lease.js";
import { KnowledgeJobs } from "./ingestion/jobs.js";
import { indexArtifact } from "./ingestion/indexer.js";
import { indexProfile } from "./ingestion/profile.js";
import { parseKnowledge } from "./ingestion/parsers.js";
import { textBlocks } from "./ingestion/text.js";
import { KnowledgeRetriever } from "./retrieval.js";

describe.skipIf(process.env.RAG_INTEGRATION !== "1")("knowledge management completion", () => {
  let pool: pg.Pool; let repo: KnowledgeRepository; let storage: LocalKnowledgeStorage; let root: string;
  const owner = randomUUID(); const other = randomUUID(); const queue = `management-${randomUUID()}`;
  let first: string; let second: string;
  beforeAll(async () => {
    pool = new pg.Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(pool, migrations); await pool.query("INSERT INTO users(id,name) VALUES($1,'management fixture'),($2,'other management fixture')", [owner, other]);
    root = await mkdtemp(resolve(tmpdir(), "rag-management-")); storage = new LocalKnowledgeStorage(resolve(root, "knowledge")); repo = new KnowledgeRepository(pool, queue);
    first = (await repo.createCollection(owner, { name: "一", description: "说明", tags: ["产品"] }, randomUUID())).id;
    second = (await repo.createCollection(owner, { name: "二", description: "" }, randomUUID())).id;
  });
  afterAll(async () => {
    try { await pool.query("DELETE FROM assets WHERE user_id=ANY($1::text[])", [[owner, other]]); await pool.query("DELETE FROM tasks WHERE user_id=ANY($1::text[])", [[owner, other]]); await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner, other]]); }
    finally { await pool.end(); await rm(root, { recursive: true, force: true }); }
  });
  it("maintains collection tags, batch memberships and inbox/filter semantics", async () => {
    const item = await repo.createItem(owner, { sourceType: "note", title: "收件箱", description: "", content: "正文", collectionIds: [], tags: ["A"] }, randomUUID());
    expect((await repo.listCollections(owner)).data.find((row) => row.id === first)?.tags).toEqual(["产品"]);
    expect((await repo.listItems(owner, 30, undefined, undefined, { inbox: true })).data.map((row) => row.id)).toContain(item.id);
    await repo.bulkMembership(owner, [item.id], [first, second], true);
    await repo.bulkMembership(owner, [item.id], [first], false);
    expect((await repo.getItem(owner, item.id)).collectionIds).toEqual([second]);
    expect((await repo.listItems(owner, 30, undefined, undefined, { inbox: true })).data).toHaveLength(0);
    expect((await repo.listItems(owner, 30, undefined, undefined, { tags: ["A", "B"] })).data).toHaveLength(0);
    await expect(repo.bulkMembership(other, [item.id], [first], true)).rejects.toThrow();
  });
  it("replaces a file idempotently, retains its old index on failure and denies stale/cross-owner replacements", async () => {
    const object = await storage.put(owner, Readable.from(["original text"]), "text/plain");
    const item = await repo.createItem(owner, { sourceType: "document", title: "file.txt", description: "", object, mime: "text/plain", tags: [], collectionIds: [first] }, randomUUID());
    const jobs = new KnowledgeJobs(pool); const lease = (await jobs.claim(item.taskId!, queue))!;
    await jobs.publish(lease, async () => {});
    const replacement = await storage.put(owner, Readable.from(["replacement text"]), "text/plain"); const key = randomUUID();
    const result = await repo.replaceFile(owner, item.id, 1, replacement, "text/plain", key);
    expect(await repo.replaceFile(owner, item.id, 1, replacement, "text/plain", key)).toEqual(result);
    const failed = (await jobs.claim(result.taskId!, queue))!; await jobs.fail(failed, "TEST_FAILURE", false);
    expect((await repo.getItem(owner, item.id)).activeRevisionId).toBe(item.revisionId);
    await expect(repo.replaceFile(owner, item.id, 1, replacement, "text/plain", randomUUID())).rejects.toThrow("已更新");
    await expect(repo.replaceFile(other, item.id, 2, replacement, "text/plain", randomUUID())).rejects.toThrow();
    expect(await repo.duplicate(owner, object.sha256)).toMatchObject({ id: item.id });
  });
  it("archives a private independent copy once and rejects foreign assets", async () => {
    const id = randomUUID(); await mkdir(resolve(root, "uploads")); await writeFile(resolve(root, "uploads", "fixture.txt"), "independent copy");
    await pool.query("INSERT INTO assets(id,user_id,type,storage_key,url,mime,size_bytes,original_name) VALUES ($1,$2,'upload','fixture.txt','/static/uploads/fixture.txt','text/plain',16,'fixture.txt')", [id, owner]);
    const materials = new KnowledgeMaterials(repo, storage, root);
    expect((await materials.list(owner)).map((asset) => asset.id)).toContain(id);
    expect(await materials.list(other)).toHaveLength(0);
    await expect(materials.archive(other, id, "no", "", [], [], randomUUID())).rejects.toThrow();
    const [a, b] = await Promise.all([1, 2].map(() => materials.archive(owner, id, "归档", "", [first], [], randomUUID())));
    expect(a.id).toBe(b.id);
    await rm(resolve(root, "uploads", "fixture.txt")); await pool.query("DELETE FROM assets WHERE id=$1", [id]);
    const item = await repo.getItem(owner, a.id); const file = await repo.getFile(owner, a.id, item.revisionId);
    expect(await readFile(storage.localPath(file.key), "utf8")).toBe("independent copy");
  });
  it("excludes business-scoped tasks without a conversation from list, content and archive", async () => {
    const task = randomUUID(); const id = randomUUID();
    await pool.query("INSERT INTO tasks(id,user_id,type,input) VALUES ($1,$2,'image.generate',$3)", [task, owner, JSON.stringify({ featureScope: "customer-acquisition", campaignId: randomUUID() })]);
    await pool.query("INSERT INTO assets(id,user_id,type,task_id,storage_key,url,mime,size_bytes) VALUES ($1,$2,'image',$3,'business.png','/static/assets/business.png','image/png',20)", [id, owner, task]);
    const materials = new KnowledgeMaterials(repo, storage, root);
    expect((await materials.list(owner)).some((m) => m.id === id)).toBe(false);
    await expect(materials.read(owner, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(materials.archive(owner, id, "business", "", [], [], randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("replays an upload before duplicate detection and rejects a different request", async () => {
    const app = new Hono<{ Variables: { userId: string } }>(); app.use("*", async (c, next) => { c.set("userId", owner); await next(); }); app.route("/", createKnowledgeManageRoutes(repo, storage));
    const key = randomUUID();
    const upload = (id: string) => app.request("/uploads", { method: "POST", headers: { "Idempotency-Key": id, "Content-Type": "text/plain", "X-Knowledge-Duplicate-Policy": "ask", "X-Knowledge-Metadata": encodeURIComponent(JSON.stringify({ title: "retry.txt" })) }, body: "unique replay fixture" });
    const first = await upload(key); const again = await upload(key);
    expect(first.status).toBe(201); expect(again.status).toBe(201); expect(await again.json()).toEqual(await first.json());
    expect((await upload(randomUUID())).status).toBe(409);
  });
  it("stores undescribed media without a job, starts indexing on description and withdraws cleared descriptions", async () => {
    const item = await repo.createItem(owner, { sourceType: "bookmark", title: "Link", sourceUrl: "https://fixture.invalid", description: "", collectionIds: [], tags: [] }, randomUUID());
    expect(item.taskId).toBeUndefined(); expect(await repo.getItem(owner, item.id)).toMatchObject({ indexStatus: "stored_only", pendingRevisionId: null, activeRevisionId: item.revisionId });
    const described = await repo.updateItem(owner, item.id, { version: 1, title: "Link", description: "Product", tags: [] });
    expect(described.taskId).toBeTruthy(); const jobs = new KnowledgeJobs(pool); await jobs.publish((await jobs.claim(described.taskId!, queue))!, async () => {});
    const cleared = await repo.updateItem(owner, item.id, { version: 2, title: "Link", description: "  ", tags: [] });
    expect(cleared.taskId).toBeUndefined(); expect(await repo.getItem(owner, item.id)).toMatchObject({ indexStatus: "stored_only", activeRevisionId: cleared.revisionId, pendingRevisionId: null });
    await expect(jobs.retry(owner, item.id, 3, queue)).rejects.toThrow();
  });
  it("queues an undescribed image for OCR instead of publishing it as stored-only", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
    const object = await storage.put(owner, Readable.from(png), "image/png");
    const item = await repo.createItem(owner, { sourceType: "image", title: "OCR image", mime: "image/png", object, description: "", collectionIds: [], tags: [] }, randomUUID());
    expect(item.taskId).toBeTruthy();
    expect(await repo.getItem(owner, item.id)).toMatchObject({ indexStatus: "pending", pendingRevisionId: item.revisionId, activeRevisionId: null });
    const description = "蓝色陶瓷杯，杯柄位于右侧，白色背景。";
    const artifact = await parseKnowledge({ mime: "image/png", bytes: png }, async (image) => image.mode === "describe" ? description : "");
    const jobs = new KnowledgeJobs(pool); const lease = (await jobs.claim(item.taskId!, queue))!;
    const profile = indexProfile("https://global-fixture.invalid/v1"); const vector = Array.from({ length: 1024 }, (_, n) => n ? 0 : 1);
    await indexArtifact(jobs, lease, profile, artifact, async () => ({ vector, tokens: 20 }));
    expect(await repo.getItem(owner, item.id)).toMatchObject({ indexStatus: "ready", description });
    const source = await repo.revisionText(owner, item.id, item.revisionId);
    expect(source.blocks).toEqual([{ text: description, origin: "generated_description" }]);
    const retriever = new KnowledgeRetriever(pool, profile, () => async () => ({ vector, tokens: 8 }));
    const result = await retriever.retrieve({ ownerId: owner, collectionIds: [], allOwned: true, callerKind: "internal", permission: "retrieval:read" },
      { query: "陶瓷杯", collectionIds: [], mode: "keyword", sourceTypes: ["image"], tags: [], topK: 5, allowDegraded: false });
    expect(result.results[0]).toMatchObject({ itemId: item.id, origin: "generated_description" });
  });
  it("returns durable error codes and partial parser diagnostics when reopening", async () => {
    const item = await repo.createItem(owner, { sourceType: "note", title: "failure", content: "text", description: "", collectionIds: [], tags: [] }, randomUUID());
    const jobs = new KnowledgeJobs(pool); await jobs.fail((await jobs.claim(item.taskId!, queue))!, "OCR_REQUIRED", false);
    await pool.query("UPDATE rag_item_revisions SET diagnostics=$2 WHERE id=$1", [item.revisionId, JSON.stringify({ warnings: ["OCR_REQUIRED_PAGE_2"] })]);
    expect(await repo.getItem(owner, item.id)).toMatchObject({ errorCode: "OCR_REQUIRED", diagnostics: { warnings: ["OCR_REQUIRED_PAGE_2"] } });
  });
  it("filters materials before pagination and retains generated origin after original deletion", async () => {
    const materials = new KnowledgeMaterials(repo, storage, root);
    await mkdir(resolve(root, "assets"), { recursive: true }); await writeFile(resolve(root, "assets", "generated.txt"), "generated");
    const id = randomUUID();
    await pool.query("INSERT INTO assets(id,user_id,type,storage_key,url,mime,size_bytes,original_name,created_at) VALUES($1,$2,'image','generated.txt','/static/assets/generated.txt','text/plain',9,'needle',now()-interval '1 day')", [id, owner]);
    for (let n=0;n<31;n++) await pool.query("INSERT INTO assets(user_id,type,storage_key,url,mime,size_bytes,original_name) VALUES($1,'upload','unused','unused','text/plain',1,'hay')", [owner]);
    expect((await materials.list(owner, 30, undefined, undefined, { query: "needle", source: "generated" })).map((m) => m.id)).toEqual([id]);
    const archived = await materials.archive(owner, id, "generated", "", [], ["fixture"], randomUUID());
    expect((await materials.list(owner, 30, undefined, undefined, { tag: "fixture" })).map((m) => m.id)).toEqual([id]);
    await pool.query("DELETE FROM assets WHERE id=$1", [id]);
    expect(await repo.getItem(owner, archived.id)).toMatchObject({ materialSource: "generated" });
    expect((await repo.listItems(owner, 30, undefined, undefined, { materialSource: "generated" })).data.map((i) => i.id)).toContain(archived.id);
  });
  it("holds physical GC for uploads/backups and never deletes referenced originals", async () => {
    const orphan = await storage.put(owner, Readable.from(["orphan fixture"]), "text/plain"); const old = new Date("2020-01-01T00:00:00Z"); await utimes(storage.localPath(orphan.key), old, old);
    await withKnowledgeStorageLease(pool, owner, async () => {
      const result = await collectKnowledgeGarbage(pool, resolve(root, "knowledge"), { retentionDays: 30, ownerId: owner, apply: true });
      expect(result.skippedOwners).toBeGreaterThan(0); expect(await storage.size(orphan.key)).toBeGreaterThan(0);
    });
    const hold = (await pool.query("INSERT INTO rag_backup_windows(retain_until) VALUES (now()+interval '1 hour') RETURNING id")).rows[0].id;
    try { expect((await collectKnowledgeGarbage(pool, resolve(root, "knowledge"), { retentionDays: 30, ownerId: owner, apply: true })).held).toBe(true); }
    finally { await pool.query("DELETE FROM rag_backup_windows WHERE id=$1", [hold]); }
    const result = await collectKnowledgeGarbage(pool, resolve(root, "knowledge"), { retentionDays: 30, ownerId: owner, apply: true });
    expect(result.files).toBeGreaterThan(0); await expect(storage.size(orphan.key)).rejects.toThrow();
    expect((await repo.listItems(owner)).data.length).toBeGreaterThan(0);
  });
  it("uses a server-only global scope to retrieve inbox content without expanding external scopes", async () => {
    const item = await repo.createItem(owner, { sourceType: "note", title: "global fixture", content: "独特收件箱资料", description: "", tags: [], collectionIds: [] }, randomUUID());
    const jobs = new KnowledgeJobs(pool); const lease = (await jobs.claim(item.taskId!, queue))!;
    const profile = indexProfile("https://global-fixture.invalid/v1"); const vector = Array.from({ length: 1024 }, (_, n) => n ? 0 : 1);
    await indexArtifact(jobs, lease, profile, { parserVersion: "fixture", diagnostics: [], blocks: textBlocks("独特收件箱资料") }, async () => ({ vector, tokens: 8 }));
    // Other fixtures intentionally have no index writer; remove their fake ready flag for this search.
    await pool.query("UPDATE rag_item_revisions SET index_status='failed' WHERE owner_id=$1 AND index_profile_id IS NULL", [owner]);
    const retriever = new KnowledgeRetriever(pool, profile, () => async () => ({ vector, tokens: 8 }));
    const request = { query: "独特收件箱资料", collectionIds: [], mode: "keyword" as const, sourceTypes: ["note" as const], tags: [], topK: 5, allowDegraded: false };
    const scope = { ownerId: owner, collectionIds: [], allOwned: true, callerKind: "internal" as const, permission: "retrieval:read" as const };
    expect((await retriever.retrieve(scope, request)).results[0].itemId).toBe(item.id);
    await expect(retriever.retrieve({ ...scope, callerKind: "access_key" }, request)).rejects.toThrow();
  });
});
