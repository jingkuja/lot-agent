import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectKnowledgeGarbage } from "../garbage-collector.js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../../db/migration-runner.js";
import { migrations } from "../../db/migrations/index.js";
import { KnowledgeRepository } from "../repository.js";
import { KnowledgeJobs } from "./jobs.js";
import { indexArtifact } from "./indexer.js";
import { indexProfile, type IndexProfile } from "./profile.js";
import { KnowledgeProfileBuild } from "./profile-build.js";
import { indexTable } from "./spaces.js";
import { textBlocks } from "./text.js";
import { KnowledgeRetriever } from "../retrieval.js";

describe.skipIf(process.env.RAG_INTEGRATION !== "1")("index spaces and atomic cutover", () => {
  let pool: pg.Pool; const owners: string[] = []; const profiles: string[] = [];
  const artifact = { parserVersion: "fixture", diagnostics: [], blocks: textBlocks("索引迁移资料") };
  const embed = (profile: IndexProfile) => async () => ({ tokens: 8, vector: Array.from({ length: profile.dimensions }, (_, n) => n ? 0 : 1) });
  beforeAll(async () => {
    pool = new pg.Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE }); await runMigrations(pool, migrations);
  });
  afterAll(async () => {
    try {
      await pool.query("DELETE FROM tasks WHERE user_id=ANY($1::text[])", [owners]); await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [owners]);
      for (const profile of profiles) {
        const table = (await pool.query("SELECT table_name FROM rag_index_spaces WHERE profile_id=$1", [profile])).rows[0]?.table_name;
        if (table && table !== "rag_chunks") await pool.query(`DROP TABLE ${indexTable(table)}`);
        await pool.query("DELETE FROM rag_index_spaces WHERE profile_id=$1", [profile]); await pool.query("DELETE FROM rag_index_profiles WHERE id=$1", [profile]);
      }
    } finally { await pool.end(); }
  });
  async function fixture() {
    const owner = randomUUID(); owners.push(owner); await pool.query("INSERT INTO users(id,name) VALUES($1,'index migration fixture')", [owner]);
    const queue = `profile-${owner}`; const repo = new KnowledgeRepository(pool, queue); const jobs = new KnowledgeJobs(pool);
    const collection = (await repo.createCollection(owner, { name: "迁移测试", description: "" }, randomUUID())).id;
    const item = await repo.createItem(owner, { sourceType: "note", title: "索引迁移资料", content: "索引迁移资料", description: "", tags: [], collectionIds: [collection] }, randomUUID());
    const initial = indexProfile(`https://${owner}.invalid/v1`); const target = indexProfile(initial.providerRoute, { dimensions: 3 }); profiles.push(initial.id, target.id);
    await indexArtifact(jobs, (await jobs.claim(item.taskId!, queue))!, initial, artifact, embed(initial));
    const manager = new KnowledgeProfileBuild(pool); const id = await manager.start(owner, initial, target);
    const retriever = new KnowledgeRetriever(pool, initial, (_owner, profile) => embed(profile));
    const request = { query: "索引迁移资料", collectionIds: [collection], mode: "hybrid" as const, topK: 5, sourceTypes: ["note" as const], tags: [], allowDegraded: false };
    const scope = { ownerId: owner, collectionIds: [collection], callerKind: "internal" as const, permission: "retrieval:read" as const };
    return { owner, queue, repo, jobs, item, initial, target, manager, id, retriever, request, scope };
  }
  it("keeps the old space searchable until a complete dimension migration, then supports checked rollback", async () => {
    const f = await fixture();
    await expect(f.manager.switch(f.owner, f.id, 1)).rejects.toThrow("INDEX_SWITCH_CONFLICT");
    await f.manager.build(f.owner, f.id, async () => artifact, (profile) => async () => {
      expect((await f.retriever.retrieve(f.scope, f.request)).results[0].itemId).toBe(f.item.id);
      return embed(profile)();
    });
    expect(await f.manager.switch(f.owner, f.id, 1)).toEqual({ activeProfileId: f.target.id, version: 2 });
    expect((await f.retriever.retrieve(f.scope, f.request)).results[0].itemId).toBe(f.item.id);
    expect(await f.manager.rollback(f.owner, 2)).toEqual({ activeProfileId: f.initial.id, version: 3 });
    expect((await f.retriever.retrieve(f.scope, f.request)).results).toHaveLength(1);
  });
  it("rejects incomplete cutover after concurrent content publication and resumes the new revision", async () => {
    const f = await fixture(); await f.manager.build(f.owner, f.id, async () => artifact, embed);
    const next = await f.repo.updateItem(f.owner, f.item.id, { version: 1, title: "新版本", content: "新版索引迁移资料", description: "", tags: [] });
    await indexArtifact(f.jobs, (await f.jobs.claim(next.taskId!, f.queue))!, f.initial, artifact, embed(f.initial));
    await expect(f.manager.switch(f.owner, f.id, 1)).rejects.toThrow("INDEX_BUILD_INCOMPLETE");
    await f.manager.build(f.owner, f.id, async () => artifact, embed);
    expect((await f.manager.switch(f.owner, f.id, 1)).activeProfileId).toBe(f.target.id);
  });
  it("cancels an in-flight build, fences its response and denies cross-owner switching", async () => {
    const f = await fixture();
    await expect(f.manager.build(f.owner, f.id, async () => artifact, (profile) => async () => { await f.manager.cancel(f.owner, f.id); return embed(profile)(); })).rejects.toThrow("INDEX_BUILD_CANCELLED");
    await expect(f.manager.switch(f.owner, f.id, 1)).rejects.toThrow("INDEX_SWITCH_CONFLICT");
    await expect(f.manager.switch(randomUUID(), f.id, 1)).rejects.toThrow("INDEX_SWITCH_CONFLICT");
    expect((await f.retriever.retrieve(f.scope, f.request)).results).toHaveLength(1);
  });
  it("retains rollback indexes through the retention window and prunes only expired inactive owner rows", async () => {
    const f = await fixture(); await f.manager.build(f.owner, f.id, async () => artifact, embed); await f.manager.switch(f.owner, f.id, 1);
    const root = await mkdtemp(join(tmpdir(), "rag-index-gc-"));
    try {
      expect((await collectKnowledgeGarbage(pool, root, { ownerId: f.owner, retentionDays: 30, apply: true })).indexProfiles).toBe(0);
      await pool.query("UPDATE rag_user_index_state SET switched_at=now()-interval '31 days' WHERE owner_id=$1", [f.owner]);
      await pool.query("UPDATE rag_revision_indexes SET completed_at=now()-interval '31 days' WHERE owner_id=$1", [f.owner]);
      await pool.query("UPDATE rag_profile_builds SET updated_at=now()-interval '31 days' WHERE owner_id=$1", [f.owner]);
      expect((await collectKnowledgeGarbage(pool, root, { ownerId: f.owner, retentionDays: 30 })).indexProfiles).toBe(1);
      expect((await pool.query("SELECT 1 FROM rag_revision_indexes WHERE owner_id=$1 AND profile_id=$2", [f.owner, f.initial.id])).rows).toHaveLength(1);
      expect((await collectKnowledgeGarbage(pool, root, { ownerId: f.owner, retentionDays: 30, apply: true })).indexProfiles).toBe(1);
      expect((await f.retriever.retrieve(f.scope, f.request)).results).toHaveLength(1);
      await expect(f.manager.rollback(f.owner, 2)).rejects.toThrow("INDEX_SWITCH_CONFLICT");
      expect((await collectKnowledgeGarbage(pool, root, { ownerId: f.owner, retentionDays: 30, apply: true })).indexProfiles).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
