import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { KnowledgeRepository, digest } from "./repository.js";
import { LocalKnowledgeStorage } from "./private-storage.js";
import { createKnowledgeManageRoutes, createKnowledgePreviewRoutes } from "./routes.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionStore } from "../auth/session-store.js";

// Explicit opt-in: uses the developer's existing local PG, never starts/drops a container/database.
const enabled = process.env.RAG_INTEGRATION === "1";
describe.skipIf(!enabled)("knowledge PostgreSQL and authenticated HTTP", () => {
  let pool: pg.Pool; let repository: KnowledgeRepository; let root: string; let app: Hono;
  const owner = randomUUID(); const other = randomUUID();
  const sessionToken = randomBytes(32).toString("hex"); const otherToken = randomBytes(32).toString("hex");
  let seeded = false;
  let collection: string; let second: string; let file: { id: string; revisionId: string };
  const body = { title: "测试说明.txt", collectionIds: [] as string[] };
  const headers = (token = sessionToken) => ({ Authorization: `Bearer ${token}` });
  const json = (value: unknown, token = sessionToken, key = randomUUID()) => ({
    headers: { ...headers(token), "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value),
  });
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1", "::1"].includes(process.env.PG_HOST ?? "localhost")) throw new Error("RAG integration requires a local test database");
    pool = new pg.Pool({ host: process.env.PG_HOST ?? "localhost", port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(pool, migrations);
    await runMigrations(pool, migrations);
    await pool.query("INSERT INTO users (id,name) VALUES ($1,'rag integration fixture'),($2,'rag integration fixture')", [owner, other]);
    seeded = true;
    await pool.query("INSERT INTO sessions (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')", [owner, digest(sessionToken), other, digest(otherToken)]);
    repository = new KnowledgeRepository(pool);
    root = await mkdtemp(join(tmpdir(), "rag-integration-"));
    const storage = new LocalKnowledgeStorage(root);
    const sessions = { resolve: async (token: string) => {
      const result = await pool.query("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()", [digest(token)]);
      return result.rows[0] ? { userId: result.rows[0].user_id } : null;
    } } as SessionStore;
    app = new Hono();
    app.use("/api/rag/manage/*", createAuthMiddleware(sessions));
    app.route("/api/rag/manage", createKnowledgeManageRoutes(repository, storage));
    app.route("/api/rag/preview", createKnowledgePreviewRoutes(repository, storage));
  });
  afterAll(async () => {
    if (pool) { try { if (seeded) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner, other]]); } finally { await pool.end(); } }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("applies the complete schema to an empty namespace without touching existing tables", async () => {
    const client = await pool.connect();
    const schema = `rag_check_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema},pg_catalog`);
      for (const migration of migrations) await migration.up(client);
      const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'rag_%'", [schema]);
      expect(tables.rows.map((row) => row.table_name)).toContain("rag_item_revisions");
      expect(tables.rows.length).toBe(8);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("requires session auth and does not accept forged ownership", async () => {
    expect((await app.request("/api/rag/manage/collections", { headers: { "X-Lot-User-Id": owner } })).status).toBe(401);
    expect((await app.request("/api/rag/manage/collections", { method: "POST", ...json({ name: "库", owner_id: other }) })).status).toBe(400);
  });
  it("creates idempotently across concurrent requests, rejects mismatched reuse and stale versions", async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([1, 2].map(() => app.request("/api/rag/manage/collections", { method: "POST", ...json({ name: "测试库" }, sessionToken, key) })));
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    const first = await a.json() as { id: string }; collection = first.id; expect(await b.json()).toEqual(first);
    expect((await app.request("/api/rag/manage/collections", { method: "POST", ...json({ name: "其他库" }, sessionToken, key) })).status).toBe(409);
    const change = () => app.request(`/api/rag/manage/collections/${collection}`, { method: "PATCH", ...json({ name: "已编辑", version: 1 }) });
    const changed = await Promise.all([change(), change()]); expect(changed.map((r) => r.status).sort()).toEqual([200, 409]);
    second = (await repository.createCollection(owner, { name: "第二库", description: "" }, randomUUID())).id;
  });
  it("streams a private upload; counts saved separately from searchable and deduplicates bytes", async () => {
    body.collectionIds = [collection, second];
    const upload = (key: string) => app.request("/api/rag/manage/uploads", { method: "POST", headers: { ...headers(), "Content-Type": "text/plain", "Idempotency-Key": key, "X-Knowledge-Metadata": encodeURIComponent(JSON.stringify(body)) }, body: "private bytes" });
    const key = randomUUID(); const first = await upload(key); expect(first.status).toBe(201); file = await first.json() as typeof file;
    expect(await (await upload(key)).json()).toEqual(file);
    expect((await upload(randomUUID())).status).toBe(201);
    expect(await repository.storageUsage(owner)).toBe(13);
    const view = await repository.getItem(owner, file.id);
    expect(view).toMatchObject({ storageStatus: "stored", indexStatus: "pending", activeRevisionId: null });
    expect(view).not.toHaveProperty("storageKey");
    const list = await repository.listCollections(owner); expect(list.data.find((c) => c.id === collection)).toMatchObject({ storedCount: 2, searchableCount: 0 });
    expect((await app.request(`/static/knowledge/${owner}/${digest("private bytes")}`)).status).toBe(404);
  });
  it("rejects cross-user reads and FK links, including mismatched revision/item", async () => {
    expect((await app.request(`/api/rag/manage/items/${file.id}`, { headers: headers(otherToken) })).status).toBe(404);
    expect((await app.request(`/api/rag/manage/items/${file.id}/revisions/${file.revisionId}/content`, { headers: headers(otherToken) })).status).toBe(404);
    await expect(pool.query("INSERT INTO rag_collection_items (owner_id,collection_id,item_id) VALUES ($1,$2,$3)", [other, collection, file.id])).rejects.toMatchObject({ code: "23503" });
    const note = await repository.createItem(owner, { title: "笔记", sourceType: "note", content: "text", description: "", collectionIds: [], tags: [] }, randomUUID());
    await expect(pool.query("UPDATE rag_items SET active_revision_id=$3 WHERE owner_id=$1 AND id=$2", [owner, note.id, file.revisionId])).rejects.toMatchObject({ code: "23503" });
    const object = await pool.query("SELECT object_id FROM rag_item_revisions WHERE id=$1", [file.revisionId]);
    await expect(pool.query("DELETE FROM rag_objects WHERE id=$1", [object.rows[0].object_id])).rejects.toMatchObject({ code: "23503" });
  });
  it("replaces notes with new revisions and rejects stale updates without publishing prematurely", async () => {
    const note = await repository.createItem(owner, { title: "笔记版本", sourceType: "note", content: "旧内容", description: "", collectionIds: [], tags: [] }, randomUUID());
    const updated = await repository.updateItem(owner, note.id, { version: 1, title: "修改", content: "新内容", description: "", tags: ["新标签"] });
    expect(updated.revisionId).not.toBe(note.revisionId);
    expect(await repository.getItem(owner, note.id)).toMatchObject({ content: "新内容", version: 2, generation: 2, activeRevisionId: null, indexStatus: "pending", tags: ["新标签"] });
    await expect(repository.updateItem(owner, note.id, { version: 1, title: "过期写入", description: "", tags: [] })).rejects.toMatchObject({ status: 409 });
    const revision = await pool.query("SELECT content,index_status FROM rag_item_revisions WHERE id=$1", [note.revisionId]);
    expect(revision.rows[0]).toMatchObject({ content: "旧内容", index_status: "cancelled" });
    const disposable = await repository.createCollection(owner, { name: "仅删除库", description: "" }, randomUUID());
    await repository.changeMembership(owner, note.id, disposable.id, true);
    expect((await repository.deleteCollection(owner, disposable.id, 1)).affectedItemIds).toEqual([note.id]);
    expect((await repository.getItem(owner, note.id)).collectionIds).toEqual([]);
  });
  it("uses stable keyset cursors without dropping records in the same millisecond", async () => {
    const at = "2026-09-23 10:11:12.123456+00";
    await pool.query("UPDATE rag_items SET created_at=$2 WHERE owner_id=$1", [owner, at]);
    const seen: string[] = []; let cursor;
    do { const page = await repository.listItems(owner, 1, cursor); seen.push(...page.data.map((row) => row.id)); cursor = page.nextCursor ?? undefined; } while (cursor);
    const total = await pool.query("SELECT count(*)::int AS n FROM rag_items WHERE owner_id=$1 AND deleted_at IS NULL", [owner]);
    expect(new Set(seen).size).toBe(total.rows[0].n);
  });
  it("removes only one association and leaves the object and other collection intact", async () => {
    await repository.changeMembership(owner, file.id, collection, false);
    expect((await repository.getItem(owner, file.id)).collectionIds).toEqual([second]);
    expect(await repository.storageUsage(owner)).toBe(13);
  });
  it("authorizes every Range and invalidates preview on logout, expiry and item deletion", async () => {
    const path = `/api/rag/manage/items/${file.id}/revisions/${file.revisionId}`;
    const content = await app.request(`${path}/content`, { headers: { ...headers(), Range: "bytes=0-6" } });
    expect(content.status).toBe(206); expect(content.headers.get("Content-Range")).toBe("bytes 0-6/13"); expect(await content.text()).toBe("private");
    expect((await app.request(`${path}/content`, { headers: { ...headers(), Range: "bytes=99-" } })).status).toBe(416);
    const createTicket = async () => {
      const response = await app.request(`${path}/preview-ticket`, { method: "POST", headers: headers() }); expect(response.status).toBe(200); return (await response.json() as { url: string }).url;
    };
    const expiredUrl = await createTicket();
    await pool.query("UPDATE rag_preview_tickets SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [digest(expiredUrl.split("/").at(-1)!)]);
    expect((await app.request(expiredUrl)).status).toBe(404);
    const otherSession = await pool.query("SELECT id FROM sessions WHERE token_hash=$1", [digest(otherToken)]);
    await expect(pool.query(`INSERT INTO rag_preview_tickets (token_hash,owner_id,session_id,item_id,revision_id,generation,expires_at)
      VALUES ($1,$2,$3,$4,$5,1,now()+interval '1 minute')`, [digest(randomUUID()), owner, otherSession.rows[0].id, file.id, file.revisionId])).rejects.toMatchObject({ code: "23503" });
    const url = await createTicket();
    expect((await app.request(url, { headers: { Range: "bytes=-5" } })).status).toBe(206);
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [digest(sessionToken)]);
    expect((await app.request(url)).status).toBe(404);
    await pool.query("UPDATE sessions SET expires_at=now()+interval '1 hour' WHERE token_hash=$1", [digest(sessionToken)]);
    const deletedTicket = await createTicket();
    expect((await repository.deleteItem(owner, file.id, 1)).affectedCollectionIds).toEqual([second]);
    expect((await app.request(deletedTicket)).status).toBe(404);
    expect((await app.request(`${path}/content`, { headers: headers() })).status).toBe(404);
    const row = await pool.query("SELECT generation,active_revision_id,pending_revision_id FROM rag_items WHERE id=$1", [file.id]);
    expect(row.rows[0]).toMatchObject({ generation: 2, active_revision_id: null, pending_revision_id: null });
    expect(await repository.storageUsage(owner)).toBe(13); // historical references count toward capacity
    // Remaining item proves session-row deletion revokes a still-live resource.
    const remaining = (await repository.listItems(owner)).data.find((item) => item.mime === "text/plain")!;
    const ticket = await repository.createPreviewTicket(owner, sessionToken, remaining.id, remaining.revisionId);
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [digest(sessionToken)]);
    await expect(repository.resolvePreviewTicket(ticket.token)).rejects.toMatchObject({ status: 404 });
  });
});
