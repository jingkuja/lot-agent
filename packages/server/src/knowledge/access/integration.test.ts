import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { validateResult, validateError } from "./contract-fixture.js";
import { serve } from "@hono/node-server";
import { KnowledgeFacts } from "../profile/repository.js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../../db/migration-runner.js";
import { migrations } from "../../db/migrations/index.js";
import { KnowledgeKeys } from "./keys.js";
import { createKnowledgeAccessRoutes } from "./routes.js";
import { KnowledgeRetriever } from "../retrieval.js";
import { indexProfile } from "../ingestion/profile.js";
import { LocalKnowledgeStorage } from "../private-storage.js";
import { tmpdir } from "node:os";

describe.skipIf(process.env.RAG_INTEGRATION !== "1")("knowledge access keys and HTTP boundary", () => {
  let pool: pg.Pool; let keys: KnowledgeKeys; let collection: string; let foreign: string;
  const owner = randomUUID(); const other = randomUUID();
  beforeAll(async () => {
    pool = new pg.Pool({ host: process.env.PG_HOST ?? "localhost", port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(pool, migrations);
    await pool.query("INSERT INTO users(id,name) VALUES($1,'key fixture'),($2,'key fixture')", [owner, other]);
    keys = new KnowledgeKeys(pool);
    collection = (await keys.repo.createCollection(owner, { name: "private", description: "" }, randomUUID())).id;
    foreign = (await keys.repo.createCollection(other, { name: "foreign", description: "" }, randomUUID())).id;
  });
  afterAll(async () => { try { await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner, other]]); } finally { await pool.end(); } });
  const create = (extra = {}) => keys.create(owner, { name: "HTTP client", collectionIds: [collection], ...extra });
  it("stores only hashes and enforces owner grants and optimistic rotation/revocation", async () => {
    await expect(create({ collectionIds: [foreign] })).rejects.toMatchObject({ status: 404 });
    const key = await create();
    const stored = (await pool.query("SELECT * FROM rag_access_keys WHERE id=$1", [key.id])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(key.token);
    expect(JSON.stringify(await keys.list(owner))).not.toContain(stored.token_hash);
    const caller = await keys.authenticate(key.token);
    const scope = await keys.scope(caller, [collection], "retrieval:read", caller.version);
    const rotated = await keys.rotate(owner, key.id, key.version);
    await expect(keys.authenticate(key.token)).rejects.toMatchObject({ status: 401 });
    await expect(keys.authorize(scope)).rejects.toMatchObject({ status: 401 });
    await expect(keys.revoke(owner, key.id, key.version)).rejects.toMatchObject({ status: 409 });
    await keys.revoke(owner, key.id, rotated.version);
    await expect(keys.authenticate(rotated.token)).rejects.toMatchObject({ status: 401 });
  });
  it("rejects expired, removed-collection and missing-scope authorization", async () => {
    const key = await create(); const caller = await keys.authenticate(key.token);
    await expect(keys.scope(caller, [collection], "profile:read", caller.version)).rejects.toMatchObject({ status: 403 });
    await pool.query("UPDATE rag_access_keys SET expires_at=now()-interval '1 second' WHERE id=$1", [key.id]);
    await expect(keys.authenticate(key.token)).rejects.toMatchObject({ status: 401 });
    const disposable = await keys.repo.createCollection(owner, { name: "deleted", description: "" }, randomUUID());
    const grant = await create({ collectionIds: [disposable.id] });
    const before = await keys.authenticate(grant.token);
    await keys.repo.deleteCollection(owner, disposable.id, 1);
    await expect(keys.scope(before, [disposable.id], "retrieval:read", before.version)).rejects.toMatchObject({ status: 404 });
  });
  it("revalidates revocation after embedding before releasing evidence", async () => {
    const key = await create(); const caller = await keys.authenticate(key.token);
    const auth = await keys.scope(caller, [collection], "retrieval:read", caller.version);
    const retriever = new KnowledgeRetriever(pool, indexProfile("https://fixture.invalid/v1"), () => async () => {
      await keys.revoke(owner, key.id, key.version);
      return { vector: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0), tokens: 1 };
    }, (scope, request) => keys.authorize(scope, request));
    await expect(retriever.retrieve(auth, { query: "test", collectionIds: [collection], mode: "semantic", topK: 5, allowDegraded: false, sourceTypes: ["note"], tags: [] })).rejects.toMatchObject({ status: 401 });
  });
  it("only returns current explicitly shared profile facts", async () => {
    const facts = new KnowledgeFacts(pool);
    await facts.save(owner, { key: "company", value: "Private", type: "text", category: "work", version: 0, collectionIds: [], shareWithApi: false });
    const key = await create({ scopes: ["profile:read"] }); const caller = await keys.authenticate(key.token);
    const auth = await keys.scope(caller, [collection], "profile:read", caller.version);
    expect(await facts.exact(auth, ["company"])).toHaveLength(0);
    await facts.save(owner, { key: "company", value: "Shared", type: "text", category: "work", version: 1, collectionIds: [], shareWithApi: true });
    expect(await facts.exact(auth, ["company"])).toMatchObject([{ value: "Shared" }]);
  });
  it("guards original bytes independently, reauthorizes Range and never leaks object paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "rag-access-file-"));
    try {
      const storage = new LocalKnowledgeStorage(root);
      const object = await storage.put(owner, Readable.from([Buffer.from("private bytes")]), "text/plain");
      const item = await keys.repo.createItem(owner, { sourceType: "document", title: "private.txt", object, mime: "text/plain", description: "", tags: [], collectionIds: [collection] }, randomUUID());
      await pool.query("UPDATE rag_items SET active_revision_id=$2,pending_revision_id=NULL WHERE id=$1", [item.id, item.revisionId]);
      const key = await create({ scopes: ["retrieval:read", "assets:read"] });
      const retriever = new KnowledgeRetriever(pool, indexProfile("https://fixture.invalid/v1"), () => async () => { throw new Error("unused"); });
      const app = createKnowledgeAccessRoutes(keys, retriever, storage, { enter: async () => async () => {} });
      const headers = { Authorization: `Bearer ${key.token}`, Range: "bytes=0-6" };
      const metadata = await (await app.request(`/items/${item.id}`, { headers })).json();
      expect(metadata).toMatchObject({ id: item.id, title: "private.txt", revision_id: item.revisionId });
      expect(JSON.stringify(metadata)).not.toContain(object.key);
      const partial = await app.request(`/assets/${item.id}/content`, { headers });
      expect(partial.status).toBe(206); expect(await partial.text()).toBe("private");
      await keys.repo.changeMembership(owner, item.id, collection, false);
      const denied = await app.request(`/assets/${item.id}/content`, { headers });
      expect(denied.status).toBe(404); await denied.arrayBuffer();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not degrade quota failures or over-budget queries", async () => {
    const key = await create(); const caller = await keys.authenticate(key.token);
    const auth = await keys.scope(caller, [collection], "retrieval:read", caller.version);
    const request = { query: "test", collectionIds: [collection], mode: "hybrid" as const, topK: 5, allowDegraded: true, sourceTypes: ["note" as const], tags: [] };
    const quota = new KnowledgeRetriever(pool, indexProfile("https://fixture.invalid/v1"), () => async () => { throw new Error("EMBEDDING_QUOTA_EXCEEDED"); }, (s, r) => keys.authorize(s, r));
    await expect(quota.retrieve(auth, request)).rejects.toMatchObject({ status: 402 });
    const oversized = new KnowledgeRetriever(pool, indexProfile("https://fixture.invalid/v1"), () => async () => ({ vector: [1], tokens: 2049 }), (s, r) => keys.authorize(s, r));
    await expect(oversized.retrieve(auth, request)).rejects.toMatchObject({ status: 400 });
  });
  it("validates the HTTP whitelist and scopes without leaking credentials or storage", async () => {
    const key = await create(); let active = 0;
    const retriever = new KnowledgeRetriever(pool, indexProfile("https://fixture.invalid/v1"), () => async () => { throw new Error("must not call model"); }, (s, r) => keys.authorize(s, r));
    const app = createKnowledgeAccessRoutes(keys, retriever, new LocalKnowledgeStorage(tmpdir()), { enter: async () => { active++; return async () => { active--; }; } });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("HTTP server unavailable");
    const request = async (path: string, body?: unknown, token = key.token) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const json = await response.json() as { data: Array<{ id: string }>; results?: unknown[] };
      if (response.status >= 400) expect(validateError(json), JSON.stringify(validateError.errors)).toBe(true);
      if (path === "/retrieval" && response.status === 200) expect(validateResult(json), JSON.stringify(validateResult.errors)).toBe(true); return { status: response.status, json };
    };
    try {
    expect((await request("/collections", undefined, "session-token")).status).toBe(401);
    const listed = await request("/collections"); expect(listed.status).toBe(200); expect(listed.json.data.map((x: { id: string }) => x.id)).toEqual([collection]); expect(active).toBe(0);
    expect((await request("/retrieval", { query: "text", collection_ids: [collection], owner_id: other })).status).toBe(400);
    expect((await request("/retrieval", { query: "text", collection_ids: [foreign] })).status).toBe(404);
    expect((await request("/retrieval", { query: "text", collection_ids: [collection], mode: "keyword", filters: { source_types: ["profile_fact"] } })).status).toBe(403);
    expect((await request("/profile?keys=company")).status).toBe(403);
    expect((await request(`/assets/${randomUUID()}/content`)).status).toBe(403);
    const empty = await request("/retrieval", { query: "text", collection_ids: [collection], mode: "keyword" });
    expect(empty.status).toBe(200); expect(empty.json).toMatchObject({ results: [], mode_used: "keyword", degraded: false }); expect(active).toBe(0);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
