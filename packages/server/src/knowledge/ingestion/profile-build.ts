import type { Pool } from "pg";
import { KnowledgeRepository } from "../repository.js";
import { KnowledgeError } from "../errors.js";
import { type IndexProfile, registerProfile } from "./profile.js";
import { activeProfile, createIndexSpace, spaceFor } from "./spaces.js";
import { embedArtifact, writeIndex, type EmbedOne, type IndexedChunk } from "./indexer.js";
import type { ParsedArtifact } from "./parsers.js";

export class KnowledgeProfileBuild {
  constructor(readonly pool: Pool) {}
  async start(owner: string, fallback: IndexProfile, target: IndexProfile) {
    await registerProfile(this.pool, fallback); await createIndexSpace(this.pool, target);
    const source = await activeProfile(this.pool, owner, fallback);
    if (source.id === target.id) throw new KnowledgeError("CONFLICT", 409, "目标索引规则已经生效");
    return new KnowledgeRepository(this.pool).transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`index-owner:${owner}`]);
      await client.query("INSERT INTO rag_user_index_state(owner_id,active_profile_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [owner, source.id]);
      return (await client.query("INSERT INTO rag_profile_builds(owner_id,source_profile_id,target_profile_id) VALUES($1,$2,$3) RETURNING id", [owner, source.id, target.id])).rows[0].id as string;
    });
  }
  async build(owner: string, id: string, parse: (itemId: string, revisionId: string) => Promise<ParsedArtifact>, embedFor: (profile: IndexProfile) => EmbedOne) {
    const lock = await this.pool.connect(); const lockName = `profile-build:${id}`;
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockName]);
      const build = (await lock.query("SELECT b.*,p.config FROM rag_profile_builds b JOIN rag_index_profiles p ON p.id=b.target_profile_id WHERE b.owner_id=$1 AND b.id=$2", [owner, id])).rows[0];
      if (!build || !["building", "ready"].includes(build.status)) throw new Error("INDEX_BUILD_NOT_AVAILABLE");
      const profile = { id: build.target_profile_id, ...build.config } as IndexProfile;
      await lock.query("UPDATE rag_profile_builds SET status='building',updated_at=now() WHERE id=$1", [id]);
      const items = (await lock.query(`SELECT i.id,i.active_revision_id FROM rag_items i JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=i.active_revision_id
        WHERE i.owner_id=$1 AND i.deleted_at IS NULL AND r.index_status='ready' ORDER BY i.id`, [owner])).rows;
      for (const item of items) {
        const revisionId = item.active_revision_id;
        await lock.query(`INSERT INTO rag_profile_build_items(owner_id,build_id,item_id,revision_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(owner_id,build_id,item_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,artifact=CASE WHEN rag_profile_build_items.revision_id=EXCLUDED.revision_id THEN rag_profile_build_items.artifact ELSE NULL END`, [owner, id, item.id, revisionId]);
        if ((await lock.query("SELECT 1 FROM rag_revision_indexes WHERE owner_id=$1 AND revision_id=$2 AND profile_id=$3", [owner, revisionId, profile.id])).rows.length) continue;
        const saved = (await lock.query("SELECT artifact FROM rag_profile_build_items WHERE owner_id=$1 AND build_id=$2 AND item_id=$3", [owner, id, item.id])).rows[0]?.artifact as { parser: ParsedArtifact; chunks: IndexedChunk[] } | null;
        const parser = saved?.parser ?? await parse(item.id, revisionId);
        const checkpoint = async (chunks: IndexedChunk[]) => {
          const changed = await lock.query(`UPDATE rag_profile_build_items bi SET artifact=$4 WHERE owner_id=$1 AND build_id=$2 AND item_id=$3
            AND EXISTS(SELECT 1 FROM rag_profile_builds b WHERE b.id=bi.build_id AND b.status='building') RETURNING item_id`, [owner, id, item.id, JSON.stringify({ parser, chunks })]);
          if (!changed.rows.length) throw new Error("INDEX_BUILD_CANCELLED");
        };
        const chunks = await embedArtifact(profile, parser, embedFor(profile), saved?.chunks ?? [], checkpoint, async () => {});
        await new KnowledgeRepository(this.pool).transaction(async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`index-owner:${owner}`]);
          const state = (await client.query("SELECT status FROM rag_profile_builds WHERE owner_id=$1 AND id=$2 FOR UPDATE", [owner, id])).rows[0];
          if (state?.status !== "building") throw new Error("INDEX_BUILD_CANCELLED");
          const current = (await client.query("SELECT active_revision_id FROM rag_items WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE", [owner, item.id])).rows[0];
          if (current?.active_revision_id !== revisionId) return; // Cutover verifies the entire current manifest; rerun builds changed inputs.
          await writeIndex(client, { ownerId: owner, itemId: item.id, revisionId }, profile, chunks);
        });
      }
      await lock.query("UPDATE rag_profile_builds SET status='ready',updated_at=now() WHERE owner_id=$1 AND id=$2 AND status='building'", [owner, id]);
      return { id, status: "ready", inspectedItems: items.length };
    } finally { await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]); lock.release(); }
  }
  async switch(owner: string, id: string, expectedVersion: number) {
    return new KnowledgeRepository(this.pool).transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`index-owner:${owner}`]);
      const state = (await client.query("SELECT * FROM rag_user_index_state WHERE owner_id=$1 FOR UPDATE", [owner])).rows[0];
      const build = (await client.query("SELECT b.*,p.config FROM rag_profile_builds b JOIN rag_index_profiles p ON p.id=b.target_profile_id WHERE b.owner_id=$1 AND b.id=$2 FOR UPDATE OF b", [owner, id])).rows[0];
      if (!state || state.version !== expectedVersion || !build || build.status !== "ready" || state.active_profile_id !== build.source_profile_id) throw new Error("INDEX_SWITCH_CONFLICT");
      const profile = { id: build.target_profile_id, ...build.config } as IndexProfile;
      const table = await spaceFor(client, profile);
      const items = (await client.query(`SELECT i.id,i.active_revision_id FROM rag_items i JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id AND r.id=i.active_revision_id
        WHERE i.owner_id=$1 AND i.deleted_at IS NULL AND r.index_status='ready' ORDER BY i.id FOR SHARE OF i`, [owner])).rows;
      for (const item of items) {
        const complete = await client.query(`SELECT 1 FROM rag_revision_indexes ix WHERE ix.owner_id=$1 AND ix.item_id=$2 AND ix.revision_id=$3 AND ix.profile_id=$4
          AND ix.chunk_count=(SELECT count(*) FROM ${table} ch WHERE ch.owner_id=ix.owner_id AND ch.revision_id=ix.revision_id AND ch.profile_id=ix.profile_id)`, [owner, item.id, item.active_revision_id, profile.id]);
        if (!complete.rows.length) throw new Error("INDEX_BUILD_INCOMPLETE");
      }
      await client.query("UPDATE rag_user_index_state SET previous_profile_id=active_profile_id,active_profile_id=$2,version=version+1,switched_at=now() WHERE owner_id=$1", [owner, profile.id]);
      await client.query("UPDATE rag_profile_builds SET status='switched',updated_at=now() WHERE owner_id=$1 AND id=$2", [owner, id]);
      return { activeProfileId: profile.id, version: expectedVersion + 1 };
    });
  }
  async rollback(owner: string, expectedVersion: number) {
    const state = (await this.pool.query("SELECT * FROM rag_user_index_state WHERE owner_id=$1", [owner])).rows[0];
    if (!state?.previous_profile_id || state.version !== expectedVersion) throw new Error("INDEX_SWITCH_CONFLICT");
    const id = (await this.pool.query("INSERT INTO rag_profile_builds(owner_id,source_profile_id,target_profile_id,status) VALUES($1,$2,$3,'ready') RETURNING id", [owner, state.active_profile_id, state.previous_profile_id])).rows[0].id;
    // Refuse to roll back if new active revisions lack an old-space index; rebuild that space first.
    return this.switch(owner, id, expectedVersion);
  }
  async cancel(owner: string, id: string) {
    return (await this.pool.query("UPDATE rag_profile_builds SET status='cancelled',updated_at=now() WHERE owner_id=$1 AND id=$2 AND status IN ('building','ready') RETURNING id", [owner, id])).rows.length > 0;
  }
}
