import { readdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type pg from "pg";
import { narrationRoot } from "./narration.js";

/** Generated videos (finals and clips) whose draft no longer exists, from drafts deleted before
 * draft deletion removed them (round 6), plus take folders of deleted drafts. A job still pending
 * or running is never touched. Archived copies in the knowledge base are separate files. */
const ORPHAN_VIDEOS = `WITH orphan_jobs AS (
    SELECT t.id FROM tasks t WHERE t.type='marketing.video' AND t.status NOT IN ('pending','running')
      AND NOT EXISTS (SELECT 1 FROM marketing_video_projects p WHERE p.id::text = t.input->>'projectId')
    UNION
    SELECT s.id FROM tasks s JOIN tasks parent ON parent.id::text = s.input->>'parentId'
    WHERE s.type='marketing.segment' AND parent.status NOT IN ('pending','running')
      AND NOT EXISTS (SELECT 1 FROM marketing_video_projects p WHERE p.id::text = parent.input->>'projectId'))
  SELECT a.id, a.user_id, a.storage_key, a.size_bytes FROM assets a WHERE a.type='video' AND a.task_id IN (SELECT id FROM orphan_jobs)`;

export interface OrphanReport { videos: number; videoBytes: number; narrationFolders: number; removedFiles: number; failedFiles: number; applied: boolean }

/** Lists, or with `apply` deletes, what deleted drafts left behind under `dataRoot`. */
export async function collectMarketingOrphans(pool: pg.Pool, dataRoot: string, apply = false): Promise<OrphanReport> {
  const assets = resolve(dataRoot, "assets");
  const narration = narrationRoot(dataRoot);
  const folders = (await readdir(narration).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; }))
    .filter(name => /^[a-f0-9-]{36}$/i.test(name));
  const live = new Set((await pool.query<{ id: string }>("SELECT id::text FROM marketing_video_projects WHERE id::text = ANY($1::text[])", [folders])).rows.map(row => row.id));
  const orphanFolders = folders.filter(name => !live.has(name.toLowerCase()));
  let rows: { id: string; storage_key: string; size_bytes: string | number }[];
  const report = { videos: 0, videoBytes: 0, narrationFolders: orphanFolders.length, removedFiles: 0, failedFiles: 0, applied: apply };
  if (!apply) {
    rows = (await pool.query(ORPHAN_VIDEOS)).rows;
    return { ...report, videos: rows.length, videoBytes: rows.reduce((sum, row) => sum + Number(row.size_bytes), 0) };
  }
  // Rows go first, in one statement: a file that then fails to delete is only orphaned bytes.
  rows = (await pool.query(`DELETE FROM assets WHERE id IN (SELECT id FROM (${ORPHAN_VIDEOS}) o) RETURNING id, storage_key, size_bytes`)).rows;
  const results = await Promise.allSettled([
    ...rows.map(async row => {
      const path = resolve(assets, row.storage_key);
      if (!path.startsWith(assets + sep)) throw new Error("outside assets");
      await rm(path, { force: true });
    }),
    ...orphanFolders.map(name => rm(resolve(narration, name), { recursive: true, force: true })),
  ]);
  const failed = results.filter(result => result.status === "rejected").length;
  return { ...report, videos: rows.length, videoBytes: rows.reduce((sum, row) => sum + Number(row.size_bytes), 0), removedFiles: results.length - failed, failedFiles: failed };
}
