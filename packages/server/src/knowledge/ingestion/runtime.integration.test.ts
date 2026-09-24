import { reconcilePendingEmbeddingReceipts, reconcileEmbeddingReceipts } from "./receipts.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DB } from "../../db/database.js";
import { runMigrations } from "../../db/migration-runner.js";
import { migrations } from "../../db/migrations/index.js";
import { createUserEmbedder } from "./runtime.js";
import { indexProfile } from "./profile.js";

describe.skipIf(process.env.RAG_INTEGRATION !== "1")("embedding receipt accounting", () => {
  let db: DB; const owner = randomUUID(); const other = randomUUID();
  const profile = indexProfile("https://fixture.invalid/v1");
  const vector = Array.from({ length: 1024 }, (_, n) => n ? 0 : 1);
  beforeAll(async () => {
    db = new DB({ host: process.env.PG_HOST ?? "localhost", port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(db.pool, migrations);
    await db.pool.query("INSERT INTO users(id,name) VALUES ($1,'meter fixture'),($2,'meter other fixture')", [owner, other]);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => {
    try {
      await db.pool.query("DELETE FROM usage_logs WHERE user_id=ANY($1::text[])", [[owner, other]]);
      await db.pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner, other]]);
    } finally { await db.close(); }
  });
  function credential(key: string | null) {
    vi.spyOn(db, "getUserApiKey").mockResolvedValue(key);
    vi.spyOn(db, "ensureUserBalance").mockResolvedValue({ daily_limit: null, monthly_limit: null } as Awaited<ReturnType<DB["ensureUserBalance"]>>);
  }
  function gateway(requestId: string, logsVisible: boolean, record: { calls: number }) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer owner-key");
      const path = new URL(url).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: profile.modelId }] });
      if (path === "/api/status") return Response.json({ data: { quota_per_unit: 500000, usd_exchange_rate: 7.3 } });
      if (path === "/api/log/token") return Response.json({ data: logsVisible ? [{ request_id: requestId, model_name: profile.modelId, quota: 10 }] : [] });
      if (path === "/v1/embeddings") { record.calls++; return Response.json({ data: [{ index: 0, embedding: vector }], usage: { total_tokens: 40 } }, { headers: { "x-oneapi-request-id": requestId } }); }
      throw new Error("Unexpected endpoint");
    }));
  }
  it("writes exact charged quota once and associates it with the credential owner", async () => {
    credential("owner-key"); const id = randomUUID(); const calls = { calls: 0 }; gateway(id, true, calls);
    const result = await createUserEmbedder(db, profile, owner)("synthetic input");
    expect(result.tokens).toBe(40); expect(result.vector).toHaveLength(1024);
    const rows = (await db.pool.query("SELECT input_count,total_cost::float8 AS cost FROM usage_logs WHERE user_id=$1", [owner])).rows;
    expect(rows).toEqual([{ input_count: 40, cost: 0.000146 }]);
    expect((await db.pool.query("SELECT 1 FROM usage_logs WHERE user_id=$1", [other])).rows).toHaveLength(0);
    expect(db.getUserApiKey).toHaveBeenCalledWith(owner, true);
  });
  it("keeps delayed receipts durable and blocks another charge while reconciliation is pending", async () => {
    credential("owner-key"); const calls = { calls: 0 }; gateway(randomUUID(), false, calls);
    const embed = createUserEmbedder(db, profile, other);
    await expect(embed("synthetic input")).resolves.toMatchObject({ tokens: 40 });
    await expect(embed("another input")).rejects.toThrow("EMBEDDING_BILLING_PENDING");
    expect(calls.calls).toBe(1);
    expect((await db.pool.query("SELECT input_tokens,total_cost FROM rag_embedding_charges WHERE owner_id=$1", [other])).rows).toEqual([{ input_tokens: 40, total_cost: null }]);
  });
  it("isolates pending receipts by credential and gateway while keeping old charges durable", async () => {
    credential("new-owner-key"); const requestId = randomUUID();
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer new-owner-key");
      const path = new URL(url).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: profile.modelId }] });
      if (path === "/api/status") return Response.json({ data: { quota_per_unit: 500000, usd_exchange_rate: 7.3 } });
      if (path === "/api/log/token") return Response.json({ data: [{ request_id: requestId, model_name: profile.modelId, quota: 10 }] });
      return Response.json({ data: [{ index: 0, embedding: vector }], usage: { total_tokens: 40 } }, { headers: { "x-oneapi-request-id": requestId } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(createUserEmbedder(db, profile, other)("new key input")).resolves.toMatchObject({ tokens: 40 });
    expect((await db.pool.query("SELECT 1 FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL", [other])).rows).toHaveLength(1);
    expect((await db.pool.query("SELECT 1 FROM usage_logs WHERE user_id=$1", [other])).rows).toHaveLength(1);
    const secondRoute = { ...profile, providerRoute: "https://second-fixture.invalid/v1" };
    await expect(createUserEmbedder(db, secondRoute, other)("new route input")).resolves.toMatchObject({ tokens: 40 });
  });
  it("reconciles final-chunk delayed charges using retained original credentials without another model call", async () => {
    const pending = (await db.pool.query("SELECT request_id FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL", [other])).rows[0];
    vi.spyOn(db, "getUserApiKey").mockResolvedValue("new-owner-key");
    vi.spyOn(db, "getUserApiKeys").mockResolvedValue([{ apiKey: "owner-key", name: "old" }]);
    vi.spyOn(db, "getUserRuntimeApiKeys").mockResolvedValue([]);
    await new Promise((resolve) => setTimeout(resolve, 510));
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(new URL(url).pathname).toBe("/api/log/token");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer owner-key");
      return Response.json({ data: [{ request_id: pending.request_id, model_name: profile.modelId, quota: 10 }] });
    }); vi.stubGlobal("fetch", fetcher);
    await reconcilePendingEmbeddingReceipts(db);
    await reconcilePendingEmbeddingReceipts(db);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await db.pool.query("SELECT 1 FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL", [other])).rows).toHaveLength(0);
  });
  it("keeps legacy receipts pending until explicitly reconciled against an original key", async () => {
    const id = randomUUID();
    await db.pool.query("INSERT INTO rag_embedding_charges(owner_id,request_id,model_id,input_tokens,quota_per_unit,exchange_rate) VALUES($1,$2,$3,10,500000,7.3)", [owner, id, profile.modelId]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ request_id: id, model_name: profile.modelId, quota: 10 }] })));
    expect(await reconcileEmbeddingReceipts(db, owner, profile.providerRoute, "legacy-key")).toBe(true);
    expect((await db.pool.query("SELECT 1 FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL", [owner])).rows).toHaveLength(1);
    expect(await reconcileEmbeddingReceipts(db, owner, profile.providerRoute, "legacy-key", undefined, true)).toBe(true);
    expect((await db.pool.query("SELECT 1 FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL", [owner])).rows).toHaveLength(0);
  });
  it("marks transient preflight failures retryable", async () => {
    credential("network-fixture-key"); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(createUserEmbedder(db, profile, owner)("input")).rejects.toMatchObject({ message: "EMBEDDING_PREFLIGHT_FAILED", retryable: true });
  });
  it("rejects missing owner credentials before any network call", async () => {
    credential(null); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(createUserEmbedder(db, profile, owner)("input")).rejects.toThrow("EMBEDDING_CREDENTIAL_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
