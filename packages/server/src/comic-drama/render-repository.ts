import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  comicDramaIdSchema, comicFrozenRenderSchema, comicRenderIssue, layoutComicTimeline, type ComicFrozenRenderInput, type ComicRender,
  type ComicRenderFps, type ComicRenderRequest, type StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { COMIC_RENDER_TASK, taskQueueName } from "../jobs/task-queues.js";
import { PgComicEdits } from "./edit-repository.js";
import { ComicLibraryError, libraryMissing, libraryTransaction, libraryTransactionOn, type ComicQuery } from "./library-db.js";
import { insertComicMedia } from "./library-repository.js";
import { comicJobLockKey } from "./generation-repository.js";

const cd = "lot_comic_drama";
const view = `SELECT r.id,r.edit_id AS "editId",r.edit_revision AS "editRevision",r.project_title AS title,r.created_at AS "createdAt",
  r.created_at::text AS stamp,r.duration_ms AS "durationMs",r.media_id AS "mediaId",r.ephemeral,
  CASE WHEN r.media_id IS NOT NULL THEN 'ready' WHEN t.status IN ('pending','running','cancelled') THEN t.status ELSE 'failed' END AS status,
  CASE WHEN t.status='failed' THEN coalesce(t.error_code,'RENDER_FAILED') END AS error,
  CASE WHEN (r.frozen->>'outputFps') IN ('24','30') THEN (r.frozen->>'outputFps')::int END AS "outputFps",
  r.frozen->>'fpsMode' AS "fpsMode",
  (r.media_id IS NULL AND coalesce(t.status IN ('failed','cancelled') OR
    (t.status IN ('pending','running') AND t.updated_at<now()-interval '30 seconds'),false)) AS recoverable
  FROM ${cd}.cd_renders r LEFT JOIN tasks t ON t.id=r.id AND t.user_id=r.owner_id::text AND t.type=$3`;
type RenderRow = Omit<ComicRender, "createdAt"> & { createdAt: Date; stamp: string };
type DeletedRenderFile = { id: string; key: string };
type RemovedRender = { id: string; key: string | null; cancelled?: boolean };
const renderView = ({ createdAt, stamp: _stamp, ...row }: RenderRow): ComicRender => ({ ...row, createdAt: createdAt.toISOString() });
export class PgComicRenders {
  constructor(private readonly pool: Pool, private readonly edits = new PgComicEdits(pool)) {}

  start(owner: string, editId: string, input: ComicRenderRequest, accepting?: () => void) {
    return libraryTransaction(this.pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`comic-render-request:${owner}:${input.requestId}`]);
      const { rows: [existing] } = await db.query<{ id: string; edit_id: string; edit_revision: number; deleted_at: Date | null }>(
        `SELECT id,edit_id,edit_revision,deleted_at FROM ${cd}.cd_renders WHERE owner_id=$1 AND request_id=$2`, [owner, input.requestId]);
      if (existing) {
        if (existing.deleted_at) libraryMissing();
        if (existing.edit_id !== editId || existing.edit_revision !== input.expectedRevision) throw new ComicLibraryError("RENDER_REQUEST_CONFLICT", 409);
        return { id: existing.id, created: false };
      }
      accepting?.();
      const { timeline, sources, media, title, seriesId } = await this.edits.snapshot(db, owner, editId, input.expectedRevision);
      const fpsMode = input.fpsMode ?? "auto";
      const ephemeral = input.ephemeral === true;
      const issue = comicRenderIssue(timeline, fpsMode === "24" ? 24 : 30);
      if (issue) throw new ComicLibraryError(issue, 400);
      const id = randomUUID();
      const frozen: ComicFrozenRenderInput = {
        schemaVersion: 1, editId, editRevision: input.expectedRevision, timeline, fpsMode,
        ...(ephemeral ? { ephemeral: true } : {}),
      };
      await db.query(`INSERT INTO ${cd}.cd_renders(id,owner_id,request_id,edit_id,edit_revision,frozen,duration_ms,project_title,series_id,ephemeral)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, owner, input.requestId, editId, input.expectedRevision, frozen, layoutComicTimeline(timeline).durationMs, title, seriesId, ephemeral]);
      await db.query(`INSERT INTO ${cd}.cd_render_media(owner_id,render_id,media_id) SELECT $1,$2,unnest($3::uuid[])`, [owner, id, media]);
      await db.query(`INSERT INTO ${cd}.cd_render_takes(owner_id,render_id,take_id,media_id)
        SELECT $1,$2,take,media FROM unnest($3::uuid[],$4::uuid[]) AS s(take,media)`,
      [owner, id, sources.map(source => source.takeId), sources.map(source => source.mediaId)]);
      await db.query("INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,$2,'{}',$3,$4)",
        [id, COMIC_RENDER_TASK, owner, taskQueueName(COMIC_RENDER_TASK)]);
      return { id, created: true };
    });
  }

  async status(owner: string, id: string): Promise<ComicRender> {
    const { rows: [row] } = await this.pool.query<RenderRow>(
      `${view} WHERE r.owner_id=$1 AND r.id=$2 AND r.deleted_at IS NULL`, [owner, id, COMIC_RENDER_TASK]);
    if (!row) libraryMissing();
    return renderView(row);
  }

  async list(owner: string, editId: string | null, cursor?: string) {
    const [stamp, id, extra] = cursor?.split(",") ?? [];
    if (cursor && (extra !== undefined || !Number.isFinite(Date.parse(stamp)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicLibraryError("INVALID_CURSOR", 400);
    }
    const { rows } = await this.pool.query<RenderRow>(`${view} WHERE r.owner_id=$1 AND r.deleted_at IS NULL AND r.ephemeral=FALSE
      AND ($2::uuid IS NULL OR r.edit_id=$2)
      AND ($4::timestamptz IS NULL OR (r.created_at,r.id)<($4,$5::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT 25`,
    [owner, editId, COMIC_RENDER_TASK, stamp ?? null, id ?? null]);
    return { entries: rows.slice(0, 24).map(renderView), nextCursor: rows.length > 24 ? `${rows[23].stamp},${rows[23].id}` : null };
  }

  async hasFile(id: string, key: string) {
    const result = await this.pool.query(
      `SELECT 1 FROM ${cd}.cd_renders r JOIN ${cd}.cd_media m ON (m.owner_id,m.id)=(r.owner_id,r.media_id)
       WHERE r.id=$1 AND r.deleted_at IS NULL AND m.storage_key=$2`, [id, key]);
    return !!result.rowCount;
  }

  remove(owner: string, id: string): Promise<RemovedRender | null> {
    return libraryTransaction(this.pool, async db => {
      const { rows: [row] } = await db.query<{
        media_id: string | null; deleted_at: Date | null; deleted_storage_key: string | null; ephemeral: boolean;
      }>(
        `SELECT media_id,deleted_at,deleted_storage_key,ephemeral FROM ${cd}.cd_renders WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
        [owner, id],
      );
      if (!row) libraryMissing();
      if (row.deleted_at) return row.deleted_storage_key ? { id, key: row.deleted_storage_key } : null;
      if (!row.media_id) {
        if (!row.ephemeral) throw new ComicLibraryError("RENDER_DELETE_UNAVAILABLE", 409);
        const taskRes = await db.query(
          `UPDATE tasks SET status='cancelled',stage='已关闭预览',updated_at=now()
           WHERE id=$1 AND user_id=$2::text AND type=$3 AND status IN ('pending','running')`,
          [id, owner, COMIC_RENDER_TASK],
        );
        await db.query(`UPDATE ${cd}.cd_renders SET deleted_at=now() WHERE owner_id=$1 AND id=$2`, [owner, id]);
        await db.query(`DELETE FROM ${cd}.cd_render_takes WHERE owner_id=$1 AND render_id=$2`, [owner, id]);
        await db.query(`DELETE FROM ${cd}.cd_render_media WHERE owner_id=$1 AND render_id=$2`, [owner, id]);
        return { id, key: null, cancelled: (taskRes.rowCount ?? 0) > 0 };
      }
      await db.query(`UPDATE ${cd}.cd_renders SET media_id=NULL,deleted_at=now() WHERE owner_id=$1 AND id=$2`, [owner, id]);
      await db.query(`DELETE FROM ${cd}.cd_render_takes WHERE owner_id=$1 AND render_id=$2`, [owner, id]);
      await db.query(`DELETE FROM ${cd}.cd_render_media WHERE owner_id=$1 AND render_id=$2`, [owner, id]);

      await db.query("SAVEPOINT render_output");
      const { rows: [output] } = await db.query<{ key: string }>(
        `DELETE FROM ${cd}.cd_media m WHERE m.owner_id=$1 AND m.id=$2 AND m.mime='video/mp4' AND m.storage_key=m.id::text||'.mp4'
         AND NOT EXISTS (SELECT 1 FROM ${cd}.cd_clips c WHERE c.keyframe_media_id=m.id)
         AND NOT EXISTS (SELECT 1 FROM ${cd}.cd_style_presets s WHERE (s.owner_id,s.media_id)=(m.owner_id,m.id))
         AND NOT EXISTS (SELECT 1 FROM ${cd}.cd_speech_attempts a WHERE a.media_id=m.id)
         RETURNING m.storage_key AS key`, [owner, row.media_id],
      ).catch(async error => {
        // An export saved as a material (or referenced elsewhere) still owns its media.
        if (error.code !== "23503") throw error;
        await db.query("ROLLBACK TO SAVEPOINT render_output");
        return { rows: [] };
      });
      if (!output) return null;
      await db.query(`UPDATE ${cd}.cd_renders SET deleted_storage_key=$3 WHERE owner_id=$1 AND id=$2`, [owner, id, output.key]);
      return { id, key: output.key };
    });
  }

  async purgeDeletedFile(file: DeletedRenderFile, removeFile: (key: string) => Promise<void>) {
    try {
      await removeFile(file.key);
      await this.pool.query(`UPDATE ${cd}.cd_renders SET deleted_storage_key=NULL WHERE id=$1 AND deleted_storage_key=$2`, [file.id, file.key]);
    } catch {
      console.warn("[comic-drama] export file cleanup deferred", { renderId: file.id });
    }
  }

  async purgeDeletedFiles(removeFile: (key: string) => Promise<void>) {
    const { rows } = await this.pool.query<DeletedRenderFile>(
      `SELECT id,deleted_storage_key AS key FROM ${cd}.cd_renders
       WHERE deleted_storage_key IS NOT NULL ORDER BY deleted_at,id LIMIT 100`);
    for (const file of rows) await this.purgeDeletedFile(file, removeFile);
  }

  async purgeExpiredEphemeral(
    maxAgeMs: number,
    removeFile: (key: string) => Promise<void>,
    stopCancelled?: (id: string) => Promise<void>,
  ) {
    const { rows } = await this.pool.query<{ id: string; owner: string }>(
      `SELECT id,owner_id AS owner FROM ${cd}.cd_renders
       WHERE ephemeral=TRUE AND deleted_at IS NULL AND created_at<now()-($1::bigint*interval '1 millisecond')
       ORDER BY created_at,id LIMIT 100`,
      [maxAgeMs],
    );
    for (const row of rows) {
      const removed = await this.remove(row.owner, row.id).catch(() => null);
      if (removed?.cancelled) await stopCancelled?.(row.id).catch(() => {});
      if (removed?.key) await this.purgeDeletedFile({ id: removed.id, key: removed.key }, removeFile);
    }
  }

  private async lockTask(db: ComicQuery, owner: string, id: string) {
    const { rows: [task] } = await db.query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1 AND user_id=$2::text
      AND type=$3 AND EXISTS(SELECT 1 FROM ${cd}.cd_renders WHERE owner_id=$2::uuid AND id=$1 AND deleted_at IS NULL) FOR UPDATE`,
    [id, owner, COMIC_RENDER_TASK]);
    if (!task) libraryMissing();
    const { rows: [row] } = await db.query<{ media_id: string | null }>(
      `SELECT media_id FROM ${cd}.cd_renders WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL`, [owner, id]);
    if (!row) libraryMissing();
    return { ...task, ready: row.media_id !== null };
  }

  async control<T>(id: string, run: (connection: PoolClient) => Promise<T>) {
    const connection = await this.pool.connect();
    const key = `comic-render-control:${id}`;
    let held = false;
    try {
      const { rows: [lock] } = await connection.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [key]);
      held = lock.ok;
      if (!held) throw new ComicLibraryError("RENDER_CONTROL_BUSY", 409);
      return await run(connection);
    } finally {
      let failed: Error | undefined;
      if (held) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => { failed = new Error("Unlock failed"); });
      connection.release(failed);
    }
  }

  cancel(connection: PoolClient, owner: string, id: string) {
    return libraryTransactionOn(connection, async db => {
      const task = await this.lockTask(db, owner, id);
      if (!task.ready && task.status === "cancelled") return;
      if (task.ready || !["pending", "running"].includes(task.status)) throw new ComicLibraryError("RENDER_CANCEL_UNAVAILABLE", 409);
      await db.query("UPDATE tasks SET status='cancelled',stage='已请求取消',updated_at=now() WHERE id=$1", [id]);
    });
  }

  prepareRecovery(connection: PoolClient, owner: string, id: string) {
    return libraryTransactionOn(connection, async db => {
      const { rows: [lock] } = await db.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok", [comicJobLockKey(id)]);
      if (!lock.ok) throw new ComicLibraryError("RENDER_RECOVERY_UNAVAILABLE", 409);
      const task = await this.lockTask(db, owner, id);
      if (task.ready || !["pending", "running", "failed", "cancelled"].includes(task.status)) {
        throw new ComicLibraryError("RENDER_RECOVERY_UNAVAILABLE", 409);
      }
      if (task.status === "pending") return;
      await db.query(`UPDATE tasks SET status='pending',stage=NULL,error=NULL,error_code=NULL,attempts=0,progress=0,
        updated_at=now() WHERE id=$1`, [id]);
    });
  }

  async work(owner: string, id: string) {
    const { rows: [row] } = await this.pool.query<{ frozen: unknown; mediaId: string | null; takes: Record<string, string>; inputs: string[] }>(
      `SELECT r.frozen,r.media_id AS "mediaId",
        (SELECT jsonb_object_agg(m.take_id,m.media_id) FROM ${cd}.cd_render_takes m WHERE (m.owner_id,m.render_id)=(r.owner_id,r.id)) AS takes,
        ARRAY(SELECT m.media_id FROM ${cd}.cd_render_media m WHERE (m.owner_id,m.render_id)=(r.owner_id,r.id)) AS inputs
        FROM ${cd}.cd_renders r JOIN tasks t ON t.id=r.id AND t.user_id=r.owner_id::text AND t.type=$3 AND t.status='running'
        WHERE r.owner_id=$1 AND r.id=$2 AND r.deleted_at IS NULL`, [owner, id, COMIC_RENDER_TASK]);
    if (!row) libraryMissing();
    return { ...row, frozen: comicFrozenRenderSchema.parse(row.frozen) };
  }

  complete(id: string, file: StoredComicMedia, signal: AbortSignal, outputFps?: ComicRenderFps) {
    return libraryTransaction(this.pool, async db => {
      const task = await db.query("SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND type=$3 AND status='running' FOR UPDATE",
        [id, file.owner, COMIC_RENDER_TASK]);
      signal.throwIfAborted();
      if (!task.rowCount) throw new ComicLibraryError("RENDER_CANCELLED", 409);
      await insertComicMedia(db, file);
      const result = await db.query(
        `UPDATE ${cd}.cd_renders
         SET media_id=$3,
             frozen=CASE WHEN $4::int IS NOT NULL THEN jsonb_set(frozen,'{outputFps}',to_jsonb($4::int),true) ELSE frozen END
         WHERE id=$1 AND owner_id=$2 AND media_id IS NULL AND deleted_at IS NULL`,
        [id, file.owner, file.id, outputFps ?? null],
      );
      if (!result.rowCount) throw new ComicLibraryError("RENDER_ALREADY_PUBLISHED", 409);
      return { mediaId: file.id };
    });
  }
}
