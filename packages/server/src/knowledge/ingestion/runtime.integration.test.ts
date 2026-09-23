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
    await expect(embed("synthetic input")).rejects.toThrow("EMBEDDING_BILLING_PENDING");
    await expect(embed("another input")).rejects.toThrow("EMBEDDING_BILLING_PENDING");
    expect(calls.calls).toBe(1);
    expect((await db.pool.query("SELECT input_tokens,total_cost FROM rag_embedding_charges WHERE owner_id=$1", [other])).rows).toEqual([{ input_tokens: 40, total_cost: null }]);
  });
  it("rejects missing owner credentials before any network call", async () => {
    credential(null); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(createUserEmbedder(db, profile, owner)("input")).rejects.toThrow("EMBEDDING_CREDENTIAL_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
