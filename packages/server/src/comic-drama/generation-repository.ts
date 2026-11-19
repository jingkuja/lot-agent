import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  comicImageTakeInput, type ComicGenerationQuote, type ComicImageRequest,
  type ComicImageTake, type ComicImageTakeInput, type ComicImageTakeState, type ComicKeyframeHistory, type ComicTakeInput, type StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { COMIC_IMAGE_TASK, COMIC_VIDEO_TASK, taskQueueName } from "../jobs/task-queues.js";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";
import { insertComicCharacterVersion, insertComicMedia } from "./library-repository.js";
import { requireComicChoice } from "./dictionary.js";

export type ComicGenerationScope = { kind: "series" | "character"; id: string };
export type ComicPrice = { modelId: string; amountMicros: number; unit?: "image" | "second" };
type FrozenQuote = { stamp: string; price: ComicPrice; inputs: ComicTakeInput[]; replaceAdopted?: string[] };
type RequestRow = { id: string; taskId: string | null; confirmed: boolean; valid: boolean; frozen: FrozenQuote };
export type ComicWorkItem = { id: string; slot: number; input: ComicImageTakeInput };
export const comicJobLockKey = (id: string) => `comic-drama-image:${id}`;
const taskType = (price: ComicPrice) => price.unit === "second" ? COMIC_VIDEO_TASK : COMIC_IMAGE_TASK;

function targetId(input: ComicTakeInput) {
  return "clipId" in input ? input.clipId : input.characterId;
}
function targetKey(input: ComicTakeInput) {
  if ("clipId" in input) return `${input.mode === "keyframe" ? "keyframe" : "video"}:${input.clipId}`;
  const { target, characterId } = input;
  return `${target.kind}:${characterId}:${target.kind === "slot" ? target.outfitId : ""}:${target.key}`;
}
const namespace = "lot_comic_drama";
export const joinTakes = `FROM ${namespace}.cd_takes t JOIN ${namespace}.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
  JOIN tasks job ON job.id=r.task_id AND job.user_id=t.owner_id::text
  LEFT JOIN image_call_receipts receipt ON receipt.task_id=job.id AND receipt.user_id=t.owner_id::text AND receipt.slot=t.slot`;
const active = "job.status IN ('pending','running')";
const incomplete = "t.status IN ('pending','running','recoverable')";
const canResumeImageReceipt = "(receipt.state IN ('submitted','completed') OR receipt.state IS NULL)";
const canResumeReceipt = `CASE WHEN t.video_version IS NOT NULL THEN coalesce(t.submit_state,'unsubmitted') IN ('unsubmitted','accepted','output')
  ELSE ${canResumeImageReceipt} END`;
export const takeColumns = `t.id,t.target_id AS "targetId",t.request_id AS "requestId",t.media_id AS "mediaId",
  t.input->'target' AS "characterTarget",
  t.input->>'mode' AS mode, t.progress, t.cancel_requested_at IS NOT NULL AS "cancelRequested",
  (${incomplete} AND NOT (${active}) AND (${canResumeReceipt})) AS "canRecover",
  (t.input->>'clipRevision')::int AS "clipRevision",t.created_at AS "createdAt",
  CASE WHEN ${incomplete} AND NOT (${active}) THEN
    CASE WHEN ${canResumeReceipt} THEN 'recoverable' WHEN receipt.state='failed' THEN 'failed' ELSE 'unknown' END
    ELSE t.status END AS state,
  coalesce(t.error,receipt.error) AS error`;

export class PgComicGeneration {
  constructor(private readonly pool: Pool) {}

  private async request(owner: string, id: string, scope?: ComicGenerationScope, db: ComicQuery = this.pool, lock = false) {
    const { rows } = await db.query<RequestRow>(`SELECT id,task_id AS "taskId",confirmed_at IS NOT NULL AS confirmed,
      expires_at>clock_timestamp() AS valid,frozen FROM ${namespace}.cd_generation_requests
      WHERE owner_id=$1 AND id=$2 ${scope ? `AND ${scope.kind === "series" ? "series_id" : "character_id"}=$3` : ""}
      ${lock ? "FOR UPDATE" : ""}`, scope ? [owner, id, scope.id] : [owner, id]);
    return rows[0] ?? libraryMissing();
  }

  async busy(owner: string, inputs: ComicTakeInput[]) {
    if (!inputs.length) return new Set<string>();
    const { rows } = await this.pool.query<{ key: string }>(`SELECT target_key AS key FROM ${namespace}.cd_takes
      WHERE owner_id=$1 AND target_key=ANY($2::text[]) AND status IN ('pending','running','recoverable','unknown')`, [owner, inputs.map(targetKey)]);
    const keys = new Set(rows.map(row => row.key));
    return new Set(inputs.filter(input => keys.has(targetKey(input))).map(targetId));
  }

  async quote(owner: string, scope: ComicGenerationScope, stamp: string, price: ComicPrice | null,
    inputs: ComicTakeInput[], skipped: ComicGenerationQuote["skipped"], replaceAdopted?: string[]): Promise<ComicGenerationQuote> {
    const busy = await this.busy(owner, inputs);
    inputs = inputs.filter(input => {
      const reason = busy.has(targetId(input)) ? "BUSY" : !price ? "PRICE_UNAVAILABLE" : null;
      if (reason) skipped.push({ clipId: targetId(input), reason });
      return !reason;
    });
    if (!inputs.length || !price) return { confirmationId: null, expiresAt: null, items: [], skipped, totalMicros: null, currency: "CNY" };
    const { rows } = await this.pool.query<{ id: string; expiresAt: Date }>(`INSERT INTO ${namespace}.cd_generation_requests
      (owner_id,series_id,character_id,frozen,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes') RETURNING id,expires_at AS "expiresAt"`,
    [owner, scope.kind === "series" ? scope.id : null, scope.kind === "character" ? scope.id : null,
      { stamp, price, inputs, replaceAdopted } satisfies FrozenQuote]);
    const unit = price.unit ?? "image";
    const items = inputs.map(input => {
      const quantity = unit === "second" && "durationMs" in input ? input.durationMs / 1000 : 1;
      const references = "firstFrame" in input && input.firstFrame ? [input.firstFrame, ...input.references] : input.references;
      return { clipId: targetId(input), modelId: price.modelId, unit, quantity, amountMicros: price.amountMicros * quantity,
        referenceVersions: references.map(({ mediaId, version }) => ({ mediaId, version })) };
    });
    return { confirmationId: rows[0].id, expiresAt: rows[0].expiresAt.toISOString(), items, skipped, currency: "CNY",
      totalMicros: items.reduce((total, item) => total + item.amountMicros, 0) };
  }

  async characterStamp(db: ComicQuery, owner: string, id: string) {
    const { rows } = await db.query<{ stamp: string }>(`SELECT updated_at::text AS stamp FROM ${namespace}.cd_characters
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [owner, id]);
    return rows[0]?.stamp ?? libraryMissing();
  }

  async lockSeries(db: ComicQuery, owner: string, id: string) {
    const { rows } = await db.query<{ revision: number }>(`SELECT revision FROM ${namespace}.cd_series
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`, [owner, id]);
    return rows[0]?.revision ?? libraryMissing();
  }

  async confirm(owner: string, scope: ComicGenerationScope, id: string,
    currentPrice: (model: string, kind: "image" | "video") => Promise<ComicPrice | null>) {
    const first = await this.request(owner, id, scope);
    if (first.confirmed) return { taskId: first.taskId ?? libraryMissing(), type: taskType(first.frozen.price), created: false };
    if (!first.valid) throw new ComicLibraryError("QUOTE_EXPIRED", 409);
    const price = await currentPrice(first.frozen.price.modelId, taskType(first.frozen.price) === COMIC_VIDEO_TASK ? "video" : "image");
    return libraryTransaction(this.pool, async db => {
      const row = await this.request(owner, id, scope, db, true);
      if (row.confirmed) return { taskId: row.taskId ?? libraryMissing(), type: taskType(row.frozen.price), created: false };
      if (!row.valid) throw new ComicLibraryError("QUOTE_EXPIRED", 409);
      const { stamp, price: savedPrice, inputs } = row.frozen;
      if (!price || price.amountMicros !== savedPrice.amountMicros || price.modelId !== savedPrice.modelId || taskType(price) !== taskType(savedPrice)) {
        throw new ComicLibraryError("PRICE_CHANGED", 409);
      }
      const current = scope.kind === "series" ? String(await this.lockSeries(db, owner, scope.id)) : await this.characterStamp(db, owner, scope.id);
      if (current !== stamp) throw new ComicLibraryError("QUOTE_STALE", 409);
      const type = taskType(savedPrice);
      for (const input of inputs) {
        if ("target" in input) await requireComicChoice(db, owner, input.target.kind, input.target.key);
        else if (type === COMIC_VIDEO_TASK) {
          const { rows: [clip] } = await db.query<{ frame: string | null; adopted: string | null }>(`SELECT keyframe_take_id AS frame,
            adopted_video_take_id AS adopted FROM ${namespace}.cd_clips WHERE id=$1 AND series_id=$2 AND revision=$3`,
          [input.clipId, scope.id, input.clipRevision]);
          if (!clip || (input.firstFrame && input.firstFrame.takeId !== clip.frame) || (clip.adopted && !row.frozen.replaceAdopted?.includes(input.clipId))) {
            throw new ComicLibraryError("QUOTE_STALE", 409);
          }
        }
      }
      const taskId = randomUUID();
      await db.query("INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES($1,$2,$3,$4,$5)",
        [taskId, type, { requestId: id }, owner, taskQueueName(type)]);
      for (const [slot, input] of inputs.entries()) {
        const result = await db.query(`INSERT INTO ${namespace}.cd_takes(owner_id,request_id,target_id,target_key,slot,input,video_version)
          VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN (SELECT coalesce(max(video_version),0)+1 FROM ${namespace}.cd_takes WHERE target_id=$3) END)
          ON CONFLICT DO NOTHING RETURNING id`, [owner, id, targetId(input), targetKey(input), slot, input, type === COMIC_VIDEO_TASK]);
        if (!result.rowCount) throw new ComicLibraryError("BUSY", 409);
      }
      await db.query(`UPDATE ${namespace}.cd_generation_requests SET confirmed_at=now(),task_id=$2 WHERE id=$1`, [id, taskId]);
      await db.query(`UPDATE messages m SET metadata=m.metadata || jsonb_build_object('status','confirmed','taskId',$2::text)
        FROM ${namespace}.cd_director_quotes q WHERE q.confirmation_id=$1 AND q.owner_id=$3
        AND m.conversation_id=q.conversation_id AND m.metadata->>'comicDirectorQuoteId'=q.confirmation_id::text`, [id, taskId, owner]);
      return { taskId, type, created: true };
    });
  }

  async status(owner: string, id: string): Promise<ComicImageRequest> {
    const { rows } = await this.pool.query<ComicImageTake & { taskId: string; active: boolean; kind: "image" | "video" }>(`SELECT ${takeColumns},
      job.id AS "taskId",${active} AS active, CASE WHEN t.video_version IS NULL THEN 'image' ELSE 'video' END AS kind
      ${joinTakes} WHERE t.owner_id=$1 AND t.request_id=$2 ORDER BY t.slot`, [owner, id]);
    if (!rows[0]) libraryMissing();
    const { taskId, active: running, kind } = rows[0];
    return { id, taskId, active: running, kind, takes: rows.map(({ taskId: _task, active: _active, kind: _kind, ...take }) => take) };
  }

  async history(owner: string, seriesId: string, clipId: string): Promise<ComicKeyframeHistory> {
    const { rows } = await this.pool.query<{ approved: string | null }>(`SELECT CASE WHEN (t.input->>'clipRevision')::int=c.revision
      THEN c.keyframe_take_id ELSE NULL END AS approved FROM ${namespace}.cd_series s JOIN ${namespace}.cd_clips c ON c.series_id=s.id
      LEFT JOIN ${namespace}.cd_takes t ON t.id=c.keyframe_take_id AND t.owner_id=s.owner_id
      WHERE s.owner_id=$1 AND s.id=$2 AND c.id=$3 AND s.deleted_at IS NULL`, [owner, seriesId, clipId]);
    if (!rows[0]) libraryMissing();
    const approvedTakeId = rows[0].approved;
    const takes = await this.pool.query<ComicImageTake>(`SELECT ${takeColumns} ${joinTakes}
      WHERE t.owner_id=$1 AND r.series_id=$2 AND t.target_id=$3 AND t.video_version IS NULL
      ORDER BY (t.id IS NOT DISTINCT FROM $4::uuid) DESC,t.created_at DESC,t.id DESC LIMIT 30`, [owner, seriesId, clipId, approvedTakeId]);
    return { approvedTakeId, takes: takes.rows };
  }

  async characterHistory(owner: string, id: string) {
    const exists = await this.pool.query(`SELECT 1 FROM ${namespace}.cd_characters WHERE owner_id=$1 AND id=$2`, [owner, id]);
    if (!exists.rowCount) libraryMissing();
    const { rows } = await this.pool.query<ComicImageTake>(`SELECT ${takeColumns} ${joinTakes}
      WHERE t.owner_id=$1 AND r.character_id=$2
      ORDER BY t.created_at DESC,t.id DESC LIMIT 30`, [owner, id]);
    return rows;
  }

  async approve(owner: string, seriesId: string, clipId: string, takeId: string, revision: number) {
    await libraryTransaction(this.pool, async db => {
      await this.lockSeries(db, owner, seriesId);
      const { rowCount } = await db.query(`UPDATE ${namespace}.cd_clips c SET keyframe_take_id=t.id
        FROM ${namespace}.cd_takes t JOIN ${namespace}.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
        WHERE r.owner_id=$1 AND r.series_id=$2 AND c.series_id=$2 AND c.id=$3 AND t.target_id=c.id
          AND t.id=$4 AND t.status='ready' AND t.video_version IS NULL AND c.revision=$5 AND (t.input->>'clipRevision')::int=$5`,
      [owner, seriesId, clipId, takeId, revision]);
      if (!rowCount) throw new ComicLibraryError("KEYFRAME_STALE_OR_UNAVAILABLE", 409);
    });
  }

  async prepareResume(owner: string, requestId: string, taskId: string) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.request(owner, requestId, undefined, db, true);
      if (row.taskId !== taskId) libraryMissing();
      if (!await this.tryTaskLock(db, taskId)) return false;
      const { rowCount } = await db.query(`UPDATE tasks job SET status='pending', attempts=0, progress=0,
        error=NULL,error_code=NULL,stage=NULL,updated_at=now() WHERE job.id=$1 AND job.user_id=$2 AND job.type=$3
        AND job.status IN ('pending','failed','cancelled','succeeded') AND EXISTS
        (SELECT 1 FROM ${namespace}.cd_takes t LEFT JOIN image_call_receipts receipt
          ON receipt.task_id=job.id AND receipt.user_id=t.owner_id::text AND receipt.slot=t.slot
          WHERE t.request_id=$4 AND t.owner_id=$2::uuid AND ${incomplete} AND ${canResumeImageReceipt})`, [taskId, owner, COMIC_IMAGE_TASK, requestId]);
      return !!rowCount;
    });
  }

  async work(owner: string, taskId: string): Promise<ComicWorkItem[]> {
    const { rows } = await this.pool.query<Omit<ComicWorkItem, "input"> & { input: unknown }>(`SELECT t.id,t.slot,t.input
      ${joinTakes} WHERE t.owner_id=$1 AND job.id=$2 AND job.type='comic-drama.image' AND job.status='running'
      AND ${incomplete} ORDER BY t.slot`, [owner, taskId]);
    return rows.map(row => ({ ...row, input: comicImageTakeInput.parse(row.input) }));
  }

  async mark(owner: string, id: string, state: Exclude<ComicImageTakeState, "ready">, error: string | null = null) {
    await this.pool.query(`UPDATE ${namespace}.cd_takes t SET status=$3,error=$4
      WHERE owner_id=$1 AND id=$2 AND ${incomplete}`, [owner, id, state, error]);
  }

  async save(owner: string, take: ComicWorkItem, media: StoredComicMedia) {
    return libraryTransaction(this.pool, async db => {
      const { input } = take;
      if ("characterId" in input) {
        // A result already paid for remains part of history even if the role has since been archived.
        const character = await db.query(`SELECT 1 FROM ${namespace}.cd_characters WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [owner, input.characterId]);
        if (!character.rowCount) libraryMissing();
      }
      const row = await db.query(`SELECT 1 FROM ${namespace}.cd_takes t WHERE owner_id=$1 AND id=$2 AND ${incomplete} FOR UPDATE`, [owner, take.id]);
      if (!row.rowCount) throw new ComicLibraryError("TAKE_NOT_WRITABLE", 409);
      await insertComicMedia(db, media);
      if ("characterId" in input) {
        await insertComicCharacterVersion(db, owner, input.characterId, input.target, media.id);
      }
      await db.query(`UPDATE ${namespace}.cd_takes SET status='ready',media_id=$3,progress=100,error=NULL,completed_at=now() WHERE owner_id=$1 AND id=$2`,
        [owner, take.id, media.id]);
    });
  }

  async pruneExpiredQuotes() {
    await this.pool.query(`DELETE FROM ${namespace}.cd_generation_requests WHERE id IN
      (SELECT id FROM ${namespace}.cd_generation_requests WHERE confirmed_at IS NULL AND expires_at<now()-interval '1 day' LIMIT 500 FOR UPDATE SKIP LOCKED)`);
  }

  private async tryTaskLock(db: ComicQuery, taskId: string) {
    const { rows } = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
      [comicJobLockKey(taskId)]);
    return rows[0].locked;
  }

  async reconcileInterrupted(canResume: (id: string) => Promise<boolean>) {
    const { rows } = await this.pool.query<{ id: string; stamp: string }>(`SELECT id,updated_at::text AS stamp FROM tasks
      WHERE type IN ($1,$2) AND status='running' AND updated_at<now()-interval '3 minutes' ORDER BY updated_at,id LIMIT 20`, [COMIC_IMAGE_TASK, COMIC_VIDEO_TASK]);
    for (const { id, stamp } of rows) {
      if (!await canResume(id)) continue;
      await libraryTransaction(this.pool, async db => {
        if (!await this.tryTaskLock(db, id)) return;
        await db.query(`UPDATE tasks SET status='failed',error='COMIC_WORKER_INTERRUPTED',error_code='COMIC_WORKER_INTERRUPTED',updated_at=now()
          WHERE id=$1 AND status='running' AND updated_at=$2::timestamptz`, [id, stamp]);
      });
    }
  }
}
