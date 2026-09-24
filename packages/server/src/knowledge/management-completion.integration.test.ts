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
