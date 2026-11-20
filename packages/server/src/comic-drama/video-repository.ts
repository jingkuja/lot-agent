import type { Pool } from "pg";
import {
  comicDramaIdSchema, comicVideoTakeInput, type ComicFrozenGenerationInput, type ComicGenerationPreviewRequest, type ComicGenerationReference,
  type ComicTakeState, type ComicVideoHistory, type ComicVideoReceipt, type ComicVideoTake, type StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { COMIC_VIDEO_TASK } from "../jobs/task-queues.js";
import { comicJobLockKey, joinTakes, PgComicGeneration, takeColumns } from "./generation-repository.js";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";
import { insertComicMedia } from "./library-repository.js";

const tables = "lot_comic_drama";
const videoColumns = `${takeColumns},r.series_id AS "seriesId",s.title AS "seriesTitle",CASE WHEN s.deleted_at IS NULL THEN c.ordinal END AS ordinal,
  coalesce(c.draft->>'scene','') AS scene,coalesce(c.adopted_video_take_id=t.id,false) AS adopted,
  t.video_version AS version,t.input->>'modelId' AS "modelId",
  coalesce(m.duration_ms,(t.input->>'durationMs')::int) AS "durationMs",t.completed_at AS "completedAt"`;
const joinVideos = `${joinTakes} JOIN ${tables}.cd_series s ON (s.owner_id,s.id)=(r.owner_id,r.series_id)
  LEFT JOIN ${tables}.cd_clips c ON c.id=t.target_id AND c.series_id=r.series_id
  LEFT JOIN ${tables}.cd_media m ON (m.owner_id,m.id)=(t.owner_id,t.media_id)`;
const receiptColumns = `coalesce(t.submit_state,'unsubmitted') AS state, t.vendor_id AS "vendorId",
  t.gateway_request_id AS "gatewayRequestId",t.gateway_http_status AS "httpStatus"`;

type VideoCheckpoint = ComicVideoReceipt & { outputUrl: string | null };
export type ComicVideoWork = { id: string; input: ComicFrozenGenerationInput };
export class PgComicVideo {
  constructor(private readonly pool: Pool) {}

  async frames(owner: string, seriesId: string, ids: string[]) {
    type Row = { clipId: string; adopted: string | null; frame: ComicFrozenGenerationInput["firstFrame"] };
    const { rows } = await this.pool.query<Row>(`SELECT c.id AS "clipId",c.adopted_video_take_id AS adopted,
      CASE WHEN m.id IS NOT NULL THEN jsonb_build_object('takeId',t.id,'mediaId',m.id,'width',m.width,'height',m.height,
      'mime',m.mime,'sizeBytes',m.size_bytes,'version',(SELECT count(*)::int FROM ${tables}.cd_takes prior
        WHERE prior.owner_id=t.owner_id AND prior.target_key=t.target_key AND (prior.created_at,prior.id)<=(t.created_at,t.id))) END AS frame
      FROM ${tables}.cd_clips c JOIN ${tables}.cd_series s ON s.id=c.series_id
      LEFT JOIN ${tables}.cd_takes t ON t.id=c.keyframe_take_id AND t.owner_id=s.owner_id AND t.video_version IS NULL
        AND t.status='ready' AND (t.input->>'clipRevision')::int=c.revision
      LEFT JOIN ${tables}.cd_media m ON (m.owner_id,m.id)=(t.owner_id,t.media_id)
      WHERE s.owner_id=$1 AND s.id=$2 AND c.id=ANY($3::uuid[])`, [owner, seriesId, ids]);
    return new Map(rows.map(row => [row.clipId, row]));
  }

  async references(owner: string, refs: NonNullable<ComicGenerationPreviewRequest["visualReferences"]>):
  Promise<(ComicGenerationReference & { kind: "style" | "scene" | "prop"; materialId: string })[]> {
    if (!refs.length) return [];
    const { rows } = await this.pool.query<Omit<ComicGenerationReference, "kind"> & { id: string; materialKind: string }>(`SELECT
      m.id,m.kind AS "materialKind",m.name AS label,f.id AS "mediaId",f.mime,f.width,f.height,f.size_bytes AS "sizeBytes",v.version
      FROM ${tables}.cd_materials m JOIN ${tables}.cd_material_versions v ON (m.owner_id,m.id)=(v.owner_id,v.material_id)
      JOIN ${tables}.cd_media f ON (v.owner_id,v.media_id)=(f.owner_id,f.id)
      WHERE m.owner_id=$1 AND m.archived_at IS NULL AND f.id=ANY($2::uuid[]) AND f.mime LIKE 'image/%'`, [owner, refs.map(item => item.mediaId)]);
    return refs.map(ref => {
      const row = rows.find(item => item.id === ref.materialId && item.mediaId === ref.mediaId);
      if (!row || row.materialKind !== (ref.kind === "style" ? "other" : ref.kind)) throw new ComicLibraryError("INVALID_REFERENCE", 400);
      const { id: materialId, materialKind: _kind, ...asset } = row;
      return { ...asset, kind: ref.kind, materialId };
    });
  }

  async clip(owner: string, seriesId: string, clipId: string): Promise<ComicVideoTake[]> {
    const exists = await this.pool.query(`SELECT 1 FROM ${tables}.cd_clips c JOIN ${tables}.cd_series s ON s.id=c.series_id
      WHERE s.owner_id=$1 AND s.id=$2 AND c.id=$3 AND s.deleted_at IS NULL`, [owner, seriesId, clipId]);
    if (!exists.rowCount) libraryMissing();
    const { rows } = await this.pool.query<ComicVideoTake>(`SELECT ${videoColumns} ${joinVideos}
      WHERE t.owner_id=$1 AND r.series_id=$2 AND t.target_id=$3 AND t.video_version IS NOT NULL
      ORDER BY (c.adopted_video_take_id IS NOT DISTINCT FROM t.id) DESC,t.video_version DESC LIMIT 30`, [owner, seriesId, clipId]);
    return rows;
  }

  async history(owner: string, filter: {
    seriesId?: string; seriesQuery?: string; adopted?: "true" | "false"; after?: string; before?: string; cursor?: string;
  }): Promise<ComicVideoHistory> {
    const [stamp, id, extra] = filter.cursor?.split(",") ?? [];
    if (filter.cursor && (extra !== undefined || !stamp || !Number.isFinite(Date.parse(stamp)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicLibraryError("INVALID_CURSOR", 400);
    }
    if (filter.after && filter.before && Date.parse(filter.after) > Date.parse(filter.before)) throw new ComicLibraryError("INVALID_INPUT", 400);
    const { rows } = await this.pool.query<ComicVideoTake & { stamp: string }>(`SELECT ${videoColumns},t.completed_at::text AS stamp ${joinVideos}
      WHERE t.owner_id=$1 AND t.status='ready' AND t.video_version IS NOT NULL AND ($2::uuid IS NULL OR r.series_id=$2)
      AND ($3::boolean IS NULL OR coalesce(c.adopted_video_take_id=t.id,false)=$3)
      AND ($4::timestamptz IS NULL OR t.completed_at>=$4) AND ($5::timestamptz IS NULL OR t.completed_at<$5)
      AND ($8='' OR strpos(lower(s.title),lower($8))>0)
      AND ($6::timestamptz IS NULL OR (t.completed_at,t.id)<($6,$7::uuid)) ORDER BY t.completed_at DESC,t.id DESC LIMIT 25`,
    [owner, filter.seriesId ?? null, filter.adopted ?? null, filter.after ?? null, filter.before ?? null, stamp ?? null, id ?? null, filter.seriesQuery ?? ""]);
    const last = rows[23];
    return { entries: rows.slice(0, 24).map(({ stamp: _stamp, ...row }) => row), nextCursor: rows.length > 24 ? `${last.stamp},${last.id}` : null };
  }

  async adopt(owner: string, seriesId: string, clipId: string, takeId: string, revision: number) {
    await libraryTransaction(this.pool, async db => {
      await new PgComicGeneration(this.pool).lockSeries(db, owner, seriesId);
      const { rowCount } = await db.query(`UPDATE ${tables}.cd_clips c SET adopted_video_take_id=t.id
        FROM ${tables}.cd_takes t JOIN ${tables}.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
        WHERE r.owner_id=$1 AND r.series_id=$2 AND c.series_id=$2 AND c.id=$3 AND t.target_id=c.id AND t.id=$4
        AND t.status='ready' AND t.video_version IS NOT NULL AND c.revision=$5`, [owner, seriesId, clipId, takeId, revision]);
      if (!rowCount) throw new ComicLibraryError("VIDEO_STALE_OR_UNAVAILABLE", 409);
    });
  }

  async take(owner: string, id: string) {
    const { rows } = await this.pool.query<ComicVideoTake & { taskId: string }>(`SELECT ${videoColumns},job.id AS "taskId" ${joinVideos}
      WHERE t.owner_id=$1 AND t.id=$2 AND t.video_version IS NOT NULL`, [owner, id]);
    return rows[0] ?? libraryMissing();
  }

  async receipt(owner: string, id: string): Promise<ComicVideoReceipt> {
    const { rows } = await this.pool.query<ComicVideoReceipt>(`SELECT ${receiptColumns} FROM ${tables}.cd_takes t
      WHERE t.owner_id=$1 AND t.id=$2 AND t.video_version IS NOT NULL`, [owner, id]);
    return rows[0] ?? libraryMissing();
  }

  async cancel(owner: string, id: string, taskId: string) {
    await libraryTransaction(this.pool, async db => {
      const parent = await db.query("SELECT 1 FROM tasks WHERE id=$1 AND user_id=$2 AND type=$3 FOR UPDATE", [taskId, owner, COMIC_VIDEO_TASK]);
      if (!parent.rowCount) libraryMissing();
      const { rowCount } = await db.query(`UPDATE ${tables}.cd_takes t SET cancel_requested_at=coalesce(t.cancel_requested_at,now()),
        status=CASE WHEN t.submit_state IS NULL THEN 'cancelled' ELSE t.status END FROM ${tables}.cd_generation_requests r
        WHERE (t.owner_id,t.request_id)=(r.owner_id,r.id) AND r.task_id=$3 AND t.owner_id=$1 AND t.id=$2 AND t.video_version IS NOT NULL
        AND t.status IN ('pending','running','recoverable','cancelled') AND coalesce(t.submit_state,'unsubmitted') IN ('unsubmitted','submitting','accepted','output')`,
      [owner, id, taskId]);
      if (!rowCount) throw new ComicLibraryError("TAKE_NOT_CANCELLABLE", 409);
      // A task whose entire pending batch was cancelled should settle immediately, even while its queue slot is delayed.
      await db.query(`UPDATE tasks job SET status='cancelled',updated_at=now() WHERE job.id=$1 AND job.status='pending' AND NOT EXISTS (
        SELECT 1 FROM ${tables}.cd_generation_requests r JOIN ${tables}.cd_takes t ON (t.owner_id,t.request_id)=(r.owner_id,r.id)
        WHERE r.task_id=job.id AND t.status IN ('pending','running'))`, [taskId]);
    });
  }

  async release(owner: string, id: string, taskId: string) {
    await libraryTransaction(this.pool, async db => {
      if (!await this.tryTaskLock(db, taskId)) throw new ComicLibraryError("TAKE_NOT_RELEASABLE", 409);
      const { rowCount } = await db.query(`UPDATE ${tables}.cd_takes t SET status='released',error='SUBMISSION_RELEASED'
        FROM ${tables}.cd_generation_requests r JOIN tasks job ON job.id=r.task_id AND job.user_id=r.owner_id::text
        WHERE (t.owner_id,t.request_id)=(r.owner_id,r.id) AND t.owner_id=$1 AND t.id=$2 AND job.id=$3 AND t.video_version IS NOT NULL
        AND job.status NOT IN ('pending','running') AND t.status IN ('pending','running','recoverable','unknown')
        AND t.submit_state IN ('unknown','submitting')`, [owner, id, taskId]);
      if (!rowCount) throw new ComicLibraryError("TAKE_NOT_RELEASABLE", 409);
    });
  }

  private async tryTaskLock(db: ComicQuery, taskId: string) {
    const { rows } = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [comicJobLockKey(taskId)]);
    return rows[0].locked;
  }

  async prepareResume(owner: string, id: string, taskId: string) {
    return libraryTransaction(this.pool, async db => {
      if (!await this.tryTaskLock(db, taskId)) return false;
      const changed = await db.query(`UPDATE tasks SET status='pending',attempts=0,stage=NULL,error=NULL,error_code=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND type=$3 AND status IN ('failed','cancelled','succeeded') RETURNING id`, [taskId, owner, COMIC_VIDEO_TASK]);
      if (!changed.rowCount) return false;
      const queued = await db.query(`UPDATE ${tables}.cd_takes t SET status='pending',cancel_requested_at=NULL,error=NULL
        FROM ${tables}.cd_generation_requests r WHERE (t.owner_id,t.request_id)=(r.owner_id,r.id) AND r.task_id=$1
        AND t.owner_id=$2 AND t.id=$3 AND t.video_version IS NOT NULL AND t.status IN ('pending','running','recoverable')
        AND coalesce(t.submit_state,'unsubmitted') IN ('unsubmitted','accepted','output')`, [taskId, owner, id]);
      if (!queued.rowCount) throw new ComicLibraryError("RECOVERY_UNAVAILABLE", 409);
      await db.query(`UPDATE ${tables}.cd_takes t SET
        status=CASE WHEN t.submit_state IN ('unknown','submitting') THEN 'unknown' ELSE 'recoverable' END
        FROM ${tables}.cd_generation_requests r WHERE (t.owner_id,t.request_id)=(r.owner_id,r.id) AND r.task_id=$1
        AND t.owner_id=$2 AND t.id<>$3 AND t.status IN ('pending','running')`, [taskId, owner, id]);
      return true;
    });
  }

  async work(owner: string, taskId: string): Promise<ComicVideoWork[]> {
    const { rows } = await this.pool.query<{ id: string; input: unknown }>(`SELECT t.id,t.input ${joinTakes}
      WHERE t.owner_id=$1 AND job.id=$2 AND job.type=$3 AND job.status='running' AND t.status IN ('pending','running') ORDER BY t.slot`,
    [owner, taskId, COMIC_VIDEO_TASK]);
    return rows.map(({ id, input }) => ({ id, input: comicVideoTakeInput.parse(input) }));
  }

  async start(owner: string, id: string) {
    const { rows } = await this.pool.query<VideoCheckpoint>(`UPDATE ${tables}.cd_takes t SET status='running'
      WHERE t.owner_id=$1 AND t.id=$2 AND t.video_version IS NOT NULL AND t.status IN ('pending','running')
      RETURNING ${receiptColumns},t.output_url AS "outputUrl"`, [owner, id]);
    return rows[0];
  }

  async claim(owner: string, id: string) {
    const { rowCount } = await this.pool.query(`UPDATE ${tables}.cd_takes t SET submit_state='submitting',progress=1 FROM ${tables}.cd_generation_requests r
      JOIN tasks job ON job.id=r.task_id AND job.user_id=r.owner_id::text WHERE (t.owner_id,t.request_id)=(r.owner_id,r.id)
      AND t.owner_id=$1 AND t.id=$2 AND t.status='running' AND t.video_version IS NOT NULL AND t.cancel_requested_at IS NULL
      AND t.submit_state IS NULL AND job.status='running'`, [owner, id]);
    return !!rowCount;
  }

  async stopped(owner: string, id: string) {
    const { rows } = await this.pool.query(`SELECT 1 FROM ${tables}.cd_takes
      WHERE owner_id=$1 AND id=$2 AND status='running' AND cancel_requested_at IS NULL`, [owner, id]);
    return !rows.length;
  }

  async accepted(owner: string, id: string, vendor: string, trace?: string) {
    await this.pool.query(`UPDATE ${tables}.cd_takes SET submit_state='accepted',vendor_id=$3,gateway_request_id=$4
      WHERE owner_id=$1 AND id=$2 AND submit_state='submitting'`, [owner, id, vendor, trace ?? null]);
  }

  async submissionFailed(owner: string, id: string, rejected: boolean, code: string, trace?: string, httpStatus?: number) {
    await this.pool.query(`UPDATE ${tables}.cd_takes SET submit_state=$3,status=$4,error=$5,gateway_request_id=$6,gateway_http_status=$7
      WHERE owner_id=$1 AND id=$2 AND submit_state='submitting'`,
    [owner, id, rejected ? "rejected" : "unknown", rejected ? "failed" : "unknown", code, trace ?? null, httpStatus ?? null]);
  }

  async output(owner: string, id: string, url: string) {
    await this.pool.query(`UPDATE ${tables}.cd_takes SET submit_state='output',output_url=$3,progress=99
      WHERE owner_id=$1 AND id=$2 AND submit_state IN ('accepted','output')`, [owner, id, url]);
  }

  async progress(owner: string, id: string, value: number) {
    if (!Number.isFinite(value)) return;
    await this.pool.query(`UPDATE ${tables}.cd_takes SET progress=greatest(progress,$3)
      WHERE owner_id=$1 AND id=$2 AND status='running'`, [owner, id, Math.min(98, Math.max(1, Math.floor(value)))]);
  }

  async mark(owner: string, id: string, status: Extract<ComicTakeState, "recoverable" | "failed">, code: string) {
    await this.pool.query(`UPDATE ${tables}.cd_takes SET status=$3,error=$4
      WHERE owner_id=$1 AND id=$2 AND status='running'`, [owner, id, status, code]);
  }

  async save(owner: string, id: string, media: StoredComicMedia) {
    await libraryTransaction(this.pool, async db => {
      const { rowCount } = await db.query(`SELECT 1 FROM ${tables}.cd_takes WHERE owner_id=$1 AND id=$2 AND video_version IS NOT NULL
        AND status='running' AND submit_state='output' FOR UPDATE`, [owner, id]);
      if (!rowCount) throw new ComicLibraryError("TAKE_NOT_WRITABLE", 409);
      await insertComicMedia(db, media);
      await db.query(`UPDATE ${tables}.cd_takes SET media_id=$3,status='ready',progress=100,error=NULL,completed_at=now()
        WHERE owner_id=$1 AND id=$2`, [owner, id, media.id]);
    });
  }
}
