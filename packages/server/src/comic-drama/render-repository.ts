import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  comicDramaIdSchema, comicFrozenRenderSchema, comicRenderIssue, layoutComicTimeline, type ComicFrozenRenderInput, type ComicRender, type ComicRenderRequest,
  type StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { COMIC_RENDER_TASK, MARKETING_VIDEO_QUEUE } from "../jobs/task-queues.js";
import { PgComicEdits } from "./edit-repository.js";
import { ComicLibraryError, libraryMissing, libraryTransaction, libraryTransactionOn, type ComicQuery } from "./library-db.js";
import { insertComicMedia } from "./library-repository.js";
import { comicJobLockKey } from "./generation-repository.js";

const cd = "lot_comic_drama";
const view = `SELECT r.id,r.edit_id AS "editId",r.edit_revision AS "editRevision",r.project_title AS title,r.created_at AS "createdAt",
  r.created_at::text AS stamp,r.duration_ms AS "durationMs",r.media_id AS "mediaId",
  CASE WHEN r.media_id IS NOT NULL THEN 'ready' WHEN t.status IN ('pending','running','cancelled') THEN t.status ELSE 'failed' END AS status,
  CASE WHEN t.status='failed' THEN coalesce(t.error_code,'RENDER_FAILED') END AS error,
  (r.media_id IS NULL AND coalesce(t.status IN ('failed','cancelled') OR
    (t.status IN ('pending','running') AND t.updated_at<now()-interval '30 seconds'),false)) AS recoverable
  FROM ${cd}.cd_renders r LEFT JOIN tasks t ON t.id=r.id AND t.user_id=r.owner_id::text AND t.type=$3`;
type RenderRow = Omit<ComicRender, "createdAt"> & { createdAt: Date; stamp: string };
const renderView = ({ createdAt, stamp: _stamp, ...row }: RenderRow): ComicRender => ({ ...row, createdAt: createdAt.toISOString() });
export class PgComicRenders {
  constructor(private readonly pool: Pool, private readonly edits = new PgComicEdits(pool)) {}

  start(owner: string, editId: string, input: ComicRenderRequest) {
    return libraryTransaction(this.pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`comic-render-request:${owner}:${input.requestId}`]);
      const { rows: [existing] } = await db.query<{ id: string; edit_id: string; edit_revision: number }>(
        `SELECT id,edit_id,edit_revision FROM ${cd}.cd_renders WHERE owner_id=$1 AND request_id=$2`, [owner, input.requestId]);
      if (existing) {
        if (existing.edit_id !== editId || existing.edit_revision !== input.expectedRevision) throw new ComicLibraryError("RENDER_REQUEST_CONFLICT", 409);
        return { id: existing.id, created: false };
      }
      const { timeline, sources, media, title, seriesId } = await this.edits.snapshot(db, owner, editId, input.expectedRevision);
      const issue = comicRenderIssue(timeline);
      if (issue) throw new ComicLibraryError(issue, 400);
      const id = randomUUID();
      const frozen: ComicFrozenRenderInput = { schemaVersion: 1, editId, editRevision: input.expectedRevision, timeline };
      await db.query(`INSERT INTO ${cd}.cd_renders(id,owner_id,request_id,edit_id,edit_revision,frozen,duration_ms,project_title,series_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, owner, input.requestId, editId, input.expectedRevision, frozen, layoutComicTimeline(timeline).durationMs, title, seriesId]);
      await db.query(`INSERT INTO ${cd}.cd_render_media(owner_id,render_id,media_id) SELECT $1,$2,unnest($3::uuid[])`, [owner, id, media]);
      await db.query(`INSERT INTO ${cd}.cd_render_takes(owner_id,render_id,take_id,media_id)
        SELECT $1,$2,take,media FROM unnest($3::uuid[],$4::uuid[]) AS s(take,media)`,
      [owner, id, sources.map(source => source.takeId), sources.map(source => source.mediaId)]);
      await db.query("INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,$2,'{}',$3,$4)", [id, COMIC_RENDER_TASK, owner, MARKETING_VIDEO_QUEUE]);
      return { id, created: true };
    });
  }

  async status(owner: string, id: string): Promise<ComicRender> {
    const { rows: [row] } = await this.pool.query<RenderRow>(`${view} WHERE r.owner_id=$1 AND r.id=$2`, [owner, id, COMIC_RENDER_TASK]);
    if (!row) libraryMissing();
    return renderView(row);
  }

  async list(owner: string, editId: string | null, cursor?: string) {
    const [stamp, id, extra] = cursor?.split(",") ?? [];
    if (cursor && (extra !== undefined || !Number.isFinite(Date.parse(stamp)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicLibraryError("INVALID_CURSOR", 400);
    }
    const { rows } = await this.pool.query<RenderRow>(`${view} WHERE r.owner_id=$1 AND ($2::uuid IS NULL OR r.edit_id=$2)
      AND ($4::timestamptz IS NULL OR (r.created_at,r.id)<($4,$5::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT 25`,
    [owner, editId, COMIC_RENDER_TASK, stamp ?? null, id ?? null]);
    return { entries: rows.slice(0, 24).map(renderView), nextCursor: rows.length > 24 ? `${rows[23].stamp},${rows[23].id}` : null };
  }

  private async lockTask(db: ComicQuery, owner: string, id: string) {
    const { rows: [task] } = await db.query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1 AND user_id=$2::text
      AND type=$3 AND EXISTS(SELECT 1 FROM ${cd}.cd_renders WHERE owner_id=$2::uuid AND id=$1) FOR UPDATE`, [id, owner, COMIC_RENDER_TASK]);
    if (!task) libraryMissing();
    const { rows: [row] } = await db.query<{ media_id: string | null }>(`SELECT media_id FROM ${cd}.cd_renders WHERE owner_id=$1 AND id=$2`, [owner, id]);
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
        WHERE r.owner_id=$1 AND r.id=$2`, [owner, id, COMIC_RENDER_TASK]);
    if (!row) libraryMissing();
    return { ...row, frozen: comicFrozenRenderSchema.parse(row.frozen) };
  }

  complete(id: string, file: StoredComicMedia, signal: AbortSignal) {
    return libraryTransaction(this.pool, async db => {
      const task = await db.query("SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND type=$3 AND status='running' FOR UPDATE",
        [id, file.owner, COMIC_RENDER_TASK]);
      signal.throwIfAborted();
      if (!task.rowCount) throw new ComicLibraryError("RENDER_CANCELLED", 409);
      await insertComicMedia(db, file);
      const result = await db.query(`UPDATE ${cd}.cd_renders SET media_id=$3 WHERE id=$1 AND owner_id=$2 AND media_id IS NULL`, [id, file.owner, file.id]);
      if (!result.rowCount) throw new ComicLibraryError("RENDER_ALREADY_PUBLISHED", 409);
      return { mediaId: file.id };
    });
  }
}
