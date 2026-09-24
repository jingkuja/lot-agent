import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgMemoryAdapter } from "@lot-agent/core";
import { runMigrations } from "../../db/migration-runner.js";
import { migrations } from "../../db/migrations/index.js";
import { KnowledgeFacts } from "./repository.js";
import { FactAwareMemory } from "./memory.js";
import { KnowledgeRepository } from "../repository.js";
import { KnowledgeJobs } from "../ingestion/jobs.js";
import { indexArtifact } from "../ingestion/indexer.js";
import { indexProfile } from "../ingestion/profile.js";
import { textBlocks } from "../ingestion/text.js";
import { KnowledgeRetriever } from "../retrieval.js";

describe.skipIf(process.env.RAG_INTEGRATION !== "1")("confirmed personal facts", () => {
  const owner = randomUUID(); const other = randomUUID(); const queue = `facts-${randomUUID()}`;
  let pool: pg.Pool; let facts: KnowledgeFacts; let collection: string;
  beforeAll(async () => {
    pool = new pg.Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
    await runMigrations(pool, migrations); await pool.query("INSERT INTO users(id,name) VALUES ($1,'facts test'),($2,'other facts test')", [owner, other]);
    facts = new KnowledgeFacts(pool, queue);
    collection = (await new KnowledgeRepository(pool).createCollection(owner, { name: "facts", description: "" }, randomUUID())).id;
  });
  afterAll(async () => {
    try {
      await pool.query("DELETE FROM user_memory WHERE user_id=ANY($1::text[])", [[owner, other]]);
      await pool.query("DELETE FROM tasks WHERE user_id=ANY($1::text[])", [[owner, other]]);
      await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner, other]]);
    } finally { await pool.end(); }
  });
  it("keeps corrections authoritative, persists candidates without rewriting confirmed values, and records history", async () => {
    const old = new PgMemoryAdapter(pool); await old.init(); await old.set(owner, "name", "A");
    const first = await facts.save(owner, { key: "display_name", value: "B", collectionIds: [collection] });
    const memory = new FactAwareMemory(old, facts);
    expect(await memory.get(owner, "name")).toBe("B");
    await facts.suggest(owner, { upserts: [{ key: "name", value: "A" }], deletes: [] }, "same-extraction");
    await facts.suggest(owner, { upserts: [{ key: "name", value: "A" }], deletes: [] }, "same-extraction");
    expect(await facts.candidates(owner)).toHaveLength(1); expect(await memory.get(owner, "name")).toBe("B");
    const second = await facts.save(owner, { key: "display_name", value: "C", version: first.version });
    await expect(facts.save(owner, { key: "display_name", value: "D", version: first.version })).rejects.toThrow("已更新");
    expect(await facts.history(owner, first.id)).toHaveLength(2); expect(await facts.history(other, first.id)).toHaveLength(0);
    await facts.save(owner, { key: "display_name", value: "C", version: second.version, active: false });
    expect(await memory.get(owner, "name")).toBeUndefined();
  });
  it("requires both external permission and per-fact visibility, and excludes future/expired facts", async () => {
    await facts.save(owner, { key: "city", value: "杭州" });
    const future = await facts.save(owner, { key: "employer", value: "公司", shareWithApi: true, validFrom: "2099-01-01T00:00:00Z" });
    const scope = { ownerId: owner, collectionIds: [], callerKind: "access_key" as const, permission: "profile:read" as const };
    expect(await facts.exact(scope, ["city", "employer"])).toHaveLength(0);
    await expect(facts.exact({ ...scope, permission: "retrieval:read" }, ["city"])).rejects.toThrow("范围不足");
    await facts.save(owner, { key: "employer", value: "公司", shareWithApi: true, version: future.version });
    expect(await facts.exact(scope, ["employer"])).toHaveLength(1);
    expect(await facts.exact({ ...scope, ownerId: other }, ["employer"])).toHaveLength(0);
  });
  it("invalidates semantic projections immediately when a confirmed value changes and fences the old worker", async () => {
    const created = await facts.save(owner, { key: "preferred_language", value: "中文", collectionIds: [collection] });
    const jobs = new KnowledgeJobs(pool); const lease = (await jobs.claim(created.taskId!, queue))!;
    const profile = indexProfile("https://fact-fixture.invalid/v1"); const vector = Array.from({ length: 1024 }, (_, n) => n ? 0 : 1);
    await indexArtifact(jobs, lease, profile, { parserVersion: "fixture", diagnostics: [], blocks: textBlocks("preferred_language: 中文").map((block) => ({ ...block, origin: "confirmed_fact" })) }, async () => ({ vector, tokens: 8 }));
    await facts.save(owner, { key: "preferred_language", value: "English", version: created.version, collectionIds: [collection] });
    const retriever = new KnowledgeRetriever(pool, profile, () => async () => ({ vector, tokens: 8 }));
    const response = await retriever.retrieve({ ownerId: owner, collectionIds: [collection], callerKind: "internal", permission: "retrieval:read" }, { query: "中文", collectionIds: [collection], mode: "keyword", sourceTypes: ["profile_fact"], tags: [], topK: 5, allowDegraded: false });
    expect(response.results).toHaveLength(0); expect(await jobs.publish(lease, async () => {})).toBe(false);
  });
});
