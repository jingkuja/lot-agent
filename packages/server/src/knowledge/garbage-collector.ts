import { readdir, lstat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { indexTable } from "./ingestion/spaces.js";
/** Explicit maintenance only. Default dry run; retention must cover the backup window. */
export async function collectKnowledgeGarbage(pool: Pool, root: string, options: { retentionDays: number; ownerId?: string; apply?: boolean; now?: Date }) {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 7) throw new Error("Retention must be at least 7 days");
  const cutoff = new Date((options.now ?? new Date()).getTime() - options.retentionDays * 86400000);
  const result = { indexProfiles: 0, revisions: 0, items: 0, objects: 0, files: 0, bytes: 0, held: false, skippedOwners: 0, dryRun: !options.apply };
  const guard = await pool.connect();
  await guard.query("SELECT pg_advisory_lock(hashtextextended('rag-gc-backup',0))");
  try {
  if ((await pool.query("SELECT 1 FROM rag_backup_windows WHERE retain_until>now() LIMIT 1")).rows.length) return { ...result, held: true };
  const users = (await pool.query("SELECT id FROM users WHERE ($1::uuid IS NULL OR id=$1) ORDER BY id", [options.ownerId ?? null])).rows;
  for (const user of users) {
    const client = await pool.connect();
    const removals: string[] = [];
    let committed = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`rag-storage:${user.id}`]);
      await client.query("BEGIN");
      if ((await client.query("SELECT 1 FROM rag_storage_leases WHERE owner_id=$1 AND expires_at>now() LIMIT 1", [user.id])).rows.length) { result.skippedOwners++; await client.query("ROLLBACK"); committed = true; continue; }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`index-owner:${user.id}`]);
      const state = (await client.query("SELECT * FROM rag_user_index_state WHERE owner_id=$1 FOR UPDATE", [user.id])).rows[0];
      // Retain the previous profile for the full backup/rollback window. Never prune a live build.
      const staleSpaces = (await client.query(`SELECT s.profile_id,s.table_name FROM rag_index_spaces s
        WHERE s.profile_id IS DISTINCT FROM $2::text
        AND (s.profile_id IS DISTINCT FROM $3::text OR $4::timestamptz<$5)
        AND EXISTS(SELECT 1 FROM rag_revision_indexes x WHERE x.owner_id=$1 AND x.profile_id=s.profile_id)
        AND NOT EXISTS(SELECT 1 FROM rag_revision_indexes x WHERE x.owner_id=$1 AND x.profile_id=s.profile_id AND x.completed_at>=$5)
        AND NOT EXISTS(SELECT 1 FROM rag_profile_builds b WHERE b.owner_id=$1 AND s.profile_id IN(b.source_profile_id,b.target_profile_id) AND (b.status IN ('building','ready') OR b.updated_at>=$5))`,
      [user.id, state?.active_profile_id ?? null, state?.previous_profile_id ?? null, state?.switched_at ?? null, cutoff])).rows;
      result.indexProfiles += staleSpaces.length;
      if (options.apply) for (const space of staleSpaces) {
        await client.query(`DELETE FROM ${indexTable(space.table_name)} WHERE owner_id=$1 AND profile_id=$2`, [user.id, space.profile_id]);
        await client.query("DELETE FROM rag_revision_indexes WHERE owner_id=$1 AND profile_id=$2", [user.id, space.profile_id]);
        await client.query("UPDATE rag_user_index_state SET previous_profile_id=NULL WHERE owner_id=$1 AND previous_profile_id=$2", [user.id, space.profile_id]);
        await client.query("DELETE FROM rag_profile_builds WHERE owner_id=$1 AND target_profile_id=$2 AND status IN ('switched','cancelled') AND updated_at<$3", [user.id, space.profile_id, cutoff]);
      }
      const obsoleteIds: string[] = []; const deletedIds: string[] = [];
      // Lock items before runs/revisions, matching cancellation/publication. Ignore in-flight revisions.
      const items = (await client.query("SELECT * FROM rag_items WHERE owner_id=$1 ORDER BY id FOR UPDATE", [user.id])).rows;
      for (const item of items) {
        const obsolete = (await client.query(`SELECT r.id FROM rag_item_revisions r WHERE r.owner_id=$1 AND r.item_id=$2
          AND r.created_at<$3 AND r.id IS DISTINCT FROM $4::uuid AND r.id IS DISTINCT FROM $5::uuid
          AND NOT EXISTS(SELECT 1 FROM rag_ingestion_runs g WHERE g.owner_id=r.owner_id AND g.revision_id=r.id AND g.status IN ('pending','running'))`, [user.id, item.id, cutoff, item.active_revision_id, item.pending_revision_id])).rows;
        result.revisions += obsolete.length; obsoleteIds.push(...obsolete.map((row) => row.id));
        if (options.apply && obsolete.length) await client.query("DELETE FROM rag_item_revisions WHERE owner_id=$1 AND id=ANY($2::uuid[])", [user.id, obsolete.map((row) => row.id)]);
        if (item.deleted_at && item.deleted_at < cutoff && !item.active_revision_id && !item.pending_revision_id) {
          result.items++; deletedIds.push(item.id);
          if (options.apply) await client.query("DELETE FROM rag_items WHERE owner_id=$1 AND id=$2", [user.id, item.id]);
        }
      }
      const unreferenced = (await client.query(`SELECT o.id,o.storage_key FROM rag_objects o WHERE o.owner_id=$1 AND o.created_at<$2
        AND NOT EXISTS(SELECT 1 FROM rag_item_revisions r WHERE r.owner_id=o.owner_id AND r.object_id=o.id AND NOT(r.id=ANY($3::uuid[])) AND NOT(r.item_id=ANY($4::uuid[]))) FOR UPDATE`, [user.id, cutoff, obsoleteIds, deletedIds])).rows;
      result.objects += unreferenced.length;
      if (options.apply && unreferenced.length) await client.query("DELETE FROM rag_objects WHERE owner_id=$1 AND id=ANY($2::uuid[])", [user.id, unreferenced.map((row) => row.id)]);
      const referenced = new Set((await client.query("SELECT storage_key FROM rag_objects WHERE owner_id=$1 AND NOT(id=ANY($2::uuid[]))", [user.id, unreferenced.map((row) => row.id)])).rows.map((row) => row.storage_key));
      const files = await readdir(resolve(root, user.id)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      for (const file of files) {
        if (!/^[a-f0-9]{64}$/.test(file) || referenced.has(`${user.id}/${file}`)) continue;
        const path = resolve(root, user.id, file); const stat = await lstat(path);
        if (!stat.isFile() || stat.mtime >= cutoff) continue;
        result.files++; result.bytes += stat.size;
        if (options.apply) removals.push(path);
      }
      await client.query("COMMIT"); committed = true;
      // Metadata is committed first. The session lock prevents a new upload from reusing these paths until unlink finishes.
      for (const path of removals) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    } catch (error) { if (!committed) await client.query("ROLLBACK"); throw error; }
    finally { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`rag-storage:${user.id}`]); client.release(); }
  }
  // Incomplete staging uploads cannot be referenced by a revision. New uploads have newer mtimes.
  if (!(await pool.query("SELECT 1 FROM rag_storage_leases WHERE expires_at>now() LIMIT 1")).rows.length) {
    const staged = await readdir(resolve(root, ".staging")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of staged) {
      if (!/^[a-f0-9-]{36,73}$/.test(file)) continue;
      const path = resolve(root, ".staging", file); const stat = await lstat(path);
      if (!stat.isFile() || stat.mtime >= cutoff) continue;
      result.files++; result.bytes += stat.size; if (options.apply) await unlink(path);
    }
  }
  return result;
  } finally { await guard.query("SELECT pg_advisory_unlock(hashtextextended('rag-gc-backup',0))"); guard.release(); }
}
