import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  comicImageTakeInput, comicVideoPromptNotices, type ComicFrozenGenerationInput, type ComicGenerationQuote, type ComicImageRequest,
  type ComicImageTake, type ComicImageTakeInput, type ComicImageTakeState, type ComicKeyframeHistory, type ComicMaterialImageKind,
  type ComicMaterialImageTake, type ComicTakeInput, type StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { COMIC_IMAGE_TASK, COMIC_VIDEO_TASK, taskQueueName } from "../jobs/task-queues.js";
import { ComicLibraryError, ComicSelectionConflictError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";
import { insertComicCharacterVersion, insertComicMaterialVersion, insertComicMedia } from "./library-repository.js";
import { requireComicChoice } from "./dictionary.js";
import { assertComicDramaCompliance } from "./compliance.js";
import { comicQuoteCurrency } from "./pricing.js";

export type ComicGenerationScope = { kind: "series" | "character" | "material"; id: string };
export type ComicPrice = { modelId: string; amountMicros: number; unit?: "image" | "second"; currency?: "CNY" | "USD" };
export type FrozenVisualReference = { materialId: string | null; mediaId: string; version: number; styleKey?: string; pinned?: true };
type FrozenQuote = {
  stamp: string; price: ComicPrice; inputs: ComicTakeInput[]; replaceAdopted?: string[];
  visualReferences?: FrozenVisualReference[]; newMaterial?: true;
};
type RequestRow = { id: string; taskId: string | null; confirmed: boolean; valid: boolean; frozen: FrozenQuote };
export type ComicWorkItem = { id: string; slot: number; input: ComicImageTakeInput };
export const comicJobLockKey = (id: string) => `comic-drama-image:${id}`;
const taskType = (price: ComicPrice) => price.unit === "second" ? COMIC_VIDEO_TASK : COMIC_IMAGE_TASK;

function targetId(input: ComicTakeInput) {
  if ("clipId" in input) return input.clipId;
  return "characterId" in input ? input.characterId : input.materialId;
}
function targetKey(input: ComicTakeInput) {
  if ("clipId" in input) return `${input.mode === "keyframe" ? "keyframe" : "video"}:${input.clipId}`;
  if ("materialId" in input) return `material:${input.materialId}`;
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
export const comicBatchCreditPaused = `EXISTS (SELECT 1 FROM ${namespace}.cd_takes paused
  WHERE paused.owner_id=t.owner_id AND paused.request_id=t.request_id AND paused.credit_check IS NOT NULL)`;
export const comicVideoCanRunDuringCreditPause = `coalesce(t.submit_state,'unsubmitted') IN ('accepted','output')`;
export const takeColumns = `t.id,t.target_id AS "targetId",t.request_id AS "requestId",t.media_id AS "mediaId",
  CASE WHEN r.character_id IS NOT NULL THEN t.input->'target' END AS "characterTarget",
  t.input->>'mode' AS mode, t.progress, t.cancel_requested_at IS NOT NULL AS "cancelRequested",
  (${incomplete} AND NOT (${active}) AND (${canResumeReceipt})
    AND (${comicVideoCanRunDuringCreditPause} OR NOT ${comicBatchCreditPaused})) AS "canRecover",
  t.credit_check AS "creditCheck",
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
      WHERE owner_id=$1 AND id=$2 ${scope ? `AND ${scope.kind === "series" ? "series_id" : scope.kind === "character" ? "character_id" : "material_id"}=$3` : ""}
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
    inputs: ComicTakeInput[], skipped: ComicGenerationQuote["skipped"], replaceAdopted?: string[],
    visualReferences?: FrozenVisualReference[], defaultCurrency: "CNY" | "USD" = comicQuoteCurrency(),
    newMaterial?: { kind: ComicMaterialImageKind; name: string }): Promise<ComicGenerationQuote> {
    const currency = price?.currency ?? defaultCurrency;
    const busy = await this.busy(owner, inputs);
    inputs = inputs.filter(input => {
      const reason = busy.has(targetId(input)) ? "BUSY" : !price ? "PRICE_UNAVAILABLE" : null;
      if (reason) skipped.push({ clipId: targetId(input), reason });
      return !reason;
    });
    if (!inputs.length || !price) return { confirmationId: null, expiresAt: null, items: [], skipped, totalMicros: null, currency };
    const storedPrice: ComicPrice = { ...price, currency };
    const insertQuote = (db: ComicQuery, currentStamp: string) => db.query<{ id: string; expiresAt: Date }>(`INSERT INTO ${namespace}.cd_generation_requests
      (owner_id,series_id,character_id,material_id,frozen,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes') RETURNING id,expires_at AS "expiresAt"`,
    [owner, scope.kind === "series" ? scope.id : null, scope.kind === "character" ? scope.id : null,
      scope.kind === "material" ? scope.id : null,
      { stamp: currentStamp, price: storedPrice, inputs, replaceAdopted, ...(visualReferences?.length ? { visualReferences } : {}),
        ...(newMaterial ? { newMaterial: true } : {}) } satisfies FrozenQuote]);
    const { rows } = newMaterial ? await libraryTransaction(this.pool, async db => {
      const { rows: [material] } = await db.query<{ stamp: string }>(`INSERT INTO ${namespace}.cd_materials (id,owner_id,kind,name,tags)
        VALUES($1,$2,$3,$4,'{}') RETURNING updated_at::text AS stamp`, [scope.id, owner, newMaterial.kind, newMaterial.name]);
      return insertQuote(db, material.stamp);
    }) : await insertQuote(this.pool, stamp);
    const unit = storedPrice.unit ?? "image";
    const items = inputs.map(input => {
      const video = "clipId" in input && input.mode !== "keyframe" ? input : undefined;
      const quantity = unit === "second" && video ? video.durationMs / 1000 : 1;
      const referenceVersions: NonNullable<ComicGenerationQuote["items"][number]["referenceVersions"]> =
        input.references.map(({ mediaId, version }) => ({ mediaId, version, ...(video ? { kind: "image" as const } : {}) }));
      if (video?.firstFrame) referenceVersions.unshift({ mediaId: video.firstFrame.mediaId, version: video.firstFrame.version, kind: "first_frame" });
      if (video?.lastFrame) referenceVersions.push({ mediaId: video.lastFrame.mediaId, version: video.lastFrame.version, kind: "last_frame" });
      for (const { kind, mediaId, version } of video?.timedReferences ?? []) referenceVersions.push({ kind, mediaId, version });
      const source = video?.timedReferences?.find(ref => ref.kind === "video");
      return { clipId: targetId(input), modelId: storedPrice.modelId, unit, quantity,
        amountMicros: Math.round(storedPrice.amountMicros * quantity), referenceVersions,
        ...(video ? { advisories: comicVideoPromptNotices(video) } : {}),
        ...(source && (video?.mode === "edit" || video?.mode === "extend") ? {
          sourceDurationMs: source.durationMs, followsSource: !!video.sourceDuration,
        } : {}),
      };
    });
    return { confirmationId: rows[0].id, expiresAt: rows[0].expiresAt.toISOString(), items, skipped, currency,
      totalMicros: items.reduce((total, item) => total + item.amountMicros, 0) };
  }

  async characterStamp(db: ComicQuery, owner: string, id: string) {
    const { rows } = await db.query<{ stamp: string }>(`SELECT updated_at::text AS stamp FROM ${namespace}.cd_characters
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [owner, id]);
    return rows[0]?.stamp ?? libraryMissing();
  }

  async materialStamp(db: ComicQuery, owner: string, id: string) {
    const { rows } = await db.query<{ stamp: string }>(`SELECT updated_at::text AS stamp FROM ${namespace}.cd_materials
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [owner, id]);
    return rows[0]?.stamp ?? libraryMissing();
  }

  async lockSeries(db: ComicQuery, owner: string, id: string) {
    const { rows } = await db.query<{ revision: number }>(`SELECT revision FROM ${namespace}.cd_series
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`, [owner, id]);
    return rows[0]?.revision ?? libraryMissing();
  }

  async confirm(owner: string, scope: ComicGenerationScope, id: string,
    currentPrice: (model: string, kind: "image" | "video") => Promise<ComicPrice | null>,
    verifyVideoFiles: (inputs: ComicFrozenGenerationInput[]) => Promise<void>,
  ) {
    const first = await this.request(owner, id, scope);
    if (first.confirmed) return { taskId: first.taskId ?? libraryMissing(), type: taskType(first.frozen.price), created: false };
    if (!first.valid) throw new ComicLibraryError("QUOTE_EXPIRED", 409);
    const price = await currentPrice(first.frozen.price.modelId, taskType(first.frozen.price) === COMIC_VIDEO_TASK ? "video" : "image");
    if (price && taskType(first.frozen.price) === COMIC_VIDEO_TASK) {
      await verifyVideoFiles(first.frozen.inputs.flatMap(input => "clipId" in input && input.mode !== "keyframe" ? [input] : []));
    }
    return libraryTransaction(this.pool, async db => {
      const row = await this.request(owner, id, scope, db, true);
      if (row.confirmed) return { taskId: row.taskId ?? libraryMissing(), type: taskType(row.frozen.price), created: false };
      if (!row.valid) throw new ComicLibraryError("QUOTE_EXPIRED", 409);
      const { stamp, price: savedPrice, inputs, visualReferences } = row.frozen;
      const expectedCurrency = savedPrice.currency ?? "CNY";
      const actualCurrency = price?.currency ?? expectedCurrency;
      if (!price || price.amountMicros !== savedPrice.amountMicros || price.modelId !== savedPrice.modelId
        || taskType(price) !== taskType(savedPrice) || actualCurrency !== expectedCurrency) {
        throw new ComicLibraryError("PRICE_CHANGED", 409);
      }
      assertComicDramaCompliance(inputs.map((input, index) => ({ field: `prompt[${index}]`, text: input.prompt })));
      const current = scope.kind === "series" ? String(await this.lockSeries(db, owner, scope.id))
        : await (scope.kind === "character" ? this.characterStamp(db, owner, scope.id) : this.materialStamp(db, owner, scope.id));
      if (current !== stamp) throw new ComicLibraryError("QUOTE_STALE", 409);
      await this.verifyVisualReferences(db, owner, visualReferences, inputs);
      const type = taskType(savedPrice);
      for (const input of inputs) {
        if ("characterId" in input) await requireComicChoice(db, owner, input.target.kind, input.target.key);
        else if ("clipId" in input && type === COMIC_VIDEO_TASK) {
          const { rows: [clip] } = await db.query<{ frame: string | null; frameMedia: string | null; adopted: string | null }>(`SELECT
            keyframe_take_id AS frame, keyframe_media_id AS "frameMedia", adopted_video_take_id AS adopted
            FROM ${namespace}.cd_clips WHERE id=$1 AND series_id=$2 AND revision=$3`,
          [input.clipId, scope.id, input.clipRevision]);
          const frameMatches = !input.firstFrame || (input.firstFrame.takeId
            ? input.firstFrame.takeId === clip?.frame
            : !clip?.frame && input.firstFrame.mediaId === clip?.frameMedia);
          if (!clip || !frameMatches || (clip.adopted && !row.frozen.replaceAdopted?.includes(input.clipId))) {
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
    const { rows } = await this.pool.query<{ approved: string | null; approvedMedia: string | null; selectionRevision: number }>(`SELECT
      CASE WHEN (t.input->>'clipRevision')::int=c.revision THEN c.keyframe_take_id ELSE NULL END AS approved,
      CASE WHEN (t.input->>'clipRevision')::int=c.revision THEN t.media_id ELSE c.keyframe_media_id END AS "approvedMedia",
      c.selection_revision AS "selectionRevision"
      FROM ${namespace}.cd_series s JOIN ${namespace}.cd_clips c ON c.series_id=s.id
      LEFT JOIN ${namespace}.cd_takes t ON t.id=c.keyframe_take_id AND t.owner_id=s.owner_id
      WHERE s.owner_id=$1 AND s.id=$2 AND c.id=$3 AND s.deleted_at IS NULL`, [owner, seriesId, clipId]);
    if (!rows[0]) libraryMissing();
    const approvedTakeId = rows[0].approved;
    const approvedMediaId = rows[0].approvedMedia;
    const selectionRevision = Number(rows[0].selectionRevision);
    const takes = await this.pool.query<ComicImageTake>(`SELECT ${takeColumns} ${joinTakes}
      WHERE t.owner_id=$1 AND r.series_id=$2 AND t.target_id=$3 AND t.video_version IS NULL
      ORDER BY (t.id IS NOT DISTINCT FROM $4::uuid) DESC,t.created_at DESC,t.id DESC LIMIT 30`, [owner, seriesId, clipId, approvedTakeId]);
    return { approvedTakeId, approvedMediaId, selectionRevision, takes: takes.rows };
  }

  async characterHistory(owner: string, id: string) {
    const exists = await this.pool.query(`SELECT 1 FROM ${namespace}.cd_characters WHERE owner_id=$1 AND id=$2`, [owner, id]);
    if (!exists.rowCount) libraryMissing();
    const { rows } = await this.pool.query<ComicImageTake>(`SELECT ${takeColumns} ${joinTakes}
      WHERE t.owner_id=$1 AND r.character_id=$2
      ORDER BY t.created_at DESC,t.id DESC LIMIT 30`, [owner, id]);
    return rows;
  }

  async materialHistory(owner: string) {
    const { rows } = await this.pool.query<ComicMaterialImageTake>(`SELECT ${takeColumns},m.name AS "materialName",m.kind AS "materialKind"
      ${joinTakes} JOIN ${namespace}.cd_materials m ON (m.owner_id,m.id)=(r.owner_id,r.material_id)
      WHERE t.owner_id=$1 ORDER BY (${incomplete} OR t.status='unknown') DESC,t.created_at DESC,t.id DESC LIMIT 30`, [owner]);
    return rows;
  }

  private async assertClipSelectionVersion(
    db: ComicQuery, seriesId: string, clipId: string, expectedClipRevision: number, expectedSelectionRevision: number,
  ) {
    const { rows: [clip] } = await db.query<{ revision: number; selectionRevision: number }>(
      `SELECT revision, selection_revision AS "selectionRevision"
       FROM ${namespace}.cd_clips WHERE series_id=$1 AND id=$2 FOR UPDATE`,
      [seriesId, clipId],
    );
    if (!clip || Number(clip.revision) !== expectedClipRevision) {
      throw new ComicLibraryError("KEYFRAME_STALE_OR_UNAVAILABLE", 409);
    }
    if (Number(clip.selectionRevision) !== expectedSelectionRevision) {
      throw new ComicSelectionConflictError(Number(clip.selectionRevision));
    }
  }

  async approve(
    owner: string, seriesId: string, clipId: string, takeId: string, revision: number, expectedSelectionRevision: number,
  ): Promise<{ selectionRevision: number }> {
    return libraryTransaction(this.pool, async db => {
      await this.lockSeries(db, owner, seriesId);
      await this.assertClipSelectionVersion(db, seriesId, clipId, revision, expectedSelectionRevision);
      const { rows } = await db.query<{ selectionRevision: number }>(`UPDATE ${namespace}.cd_clips c
        SET keyframe_take_id=t.id, keyframe_media_id=NULL, selection_revision=c.selection_revision+1
        FROM ${namespace}.cd_takes t JOIN ${namespace}.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
        WHERE r.owner_id=$1 AND r.series_id=$2 AND c.series_id=$2 AND c.id=$3 AND t.target_id=c.id
          AND t.id=$4 AND t.status='ready' AND t.video_version IS NULL AND c.revision=$5
          AND c.selection_revision=$6 AND (t.input->>'clipRevision')::int=$5
        RETURNING c.selection_revision AS "selectionRevision"`,
      [owner, seriesId, clipId, takeId, revision, expectedSelectionRevision]);
      if (!rows[0]) throw new ComicLibraryError("KEYFRAME_STALE_OR_UNAVAILABLE", 409);
      return { selectionRevision: Number(rows[0].selectionRevision) };
    });
  }

  async selectKeyframeMedia(
    owner: string, seriesId: string, clipId: string, mediaId: string, revision: number, expectedSelectionRevision: number,
  ): Promise<{ selectionRevision: number }> {
    return libraryTransaction(this.pool, async db => {
      await this.lockSeries(db, owner, seriesId);
      await this.assertClipSelectionVersion(db, seriesId, clipId, revision, expectedSelectionRevision);
      const { rows: [media] } = await db.query<{ mime: string }>(
        `SELECT mime FROM ${namespace}.cd_media WHERE owner_id=$1 AND id=$2`, [owner, mediaId],
      );
      if (!media) libraryMissing();
      if (!media.mime.startsWith("image/")) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
      const { rows } = await db.query<{ selectionRevision: number }>(
        `UPDATE ${namespace}.cd_clips
         SET keyframe_media_id=$4, keyframe_take_id=NULL, selection_revision=selection_revision+1
         WHERE series_id=$1 AND id=$2 AND revision=$3 AND selection_revision=$5
         RETURNING selection_revision AS "selectionRevision"`,
        [seriesId, clipId, revision, mediaId, expectedSelectionRevision],
      );
      if (!rows[0]) throw new ComicLibraryError("KEYFRAME_STALE_OR_UNAVAILABLE", 409);
      return { selectionRevision: Number(rows[0].selectionRevision) };
    });
  }

  async uploadKeyframeMedia(
    owner: string, seriesId: string, clipId: string, revision: number, expectedSelectionRevision: number, media: StoredComicMedia,
  ): Promise<{ mediaId: string; selectionRevision: number }> {
    return libraryTransaction(this.pool, async db => {
      await this.lockSeries(db, owner, seriesId);
      await this.assertClipSelectionVersion(db, seriesId, clipId, revision, expectedSelectionRevision);
      await insertComicMedia(db, media);
      const { rows } = await db.query<{ selectionRevision: number }>(
        `UPDATE ${namespace}.cd_clips
         SET keyframe_media_id=$4, keyframe_take_id=NULL, selection_revision=selection_revision+1
         WHERE series_id=$1 AND id=$2 AND revision=$3 AND selection_revision=$5
         RETURNING selection_revision AS "selectionRevision"`,
        [seriesId, clipId, revision, media.id, expectedSelectionRevision],
      );
      if (!rows[0]) throw new ComicLibraryError("KEYFRAME_STALE_OR_UNAVAILABLE", 409);
      return { mediaId: media.id, selectionRevision: Number(rows[0].selectionRevision) };
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
          WHERE t.request_id=$4 AND t.owner_id=$2::uuid AND t.cancel_requested_at IS NULL AND ${incomplete}
            AND ${canResumeImageReceipt})`, [taskId, owner, COMIC_IMAGE_TASK, requestId]);
      if (!rowCount) return false;
      await db.query(`UPDATE ${namespace}.cd_takes t SET status='pending', error=NULL
        WHERE t.request_id=$1 AND t.owner_id=$2::uuid AND t.video_version IS NULL
          AND t.cancel_requested_at IS NULL AND ${incomplete}
          AND NOT EXISTS (
            SELECT 1 FROM image_call_receipts receipt
            WHERE receipt.task_id=$3 AND receipt.user_id=t.owner_id::text AND receipt.slot=t.slot
              AND receipt.state NOT IN ('submitted','completed')
          )`, [requestId, owner, taskId]);
      return true;
    });
  }

  private async verifyVisualReferences(
    db: ComicQuery, owner: string, frozen: FrozenVisualReference[] | undefined, inputs: ComicTakeInput[],
  ) {
    const refs: FrozenVisualReference[] = frozen?.length ? frozen : inputs.flatMap(input =>
      "clipId" in input ? input.references.filter(ref => ref.kind === "style" || ref.kind === "scene" || ref.kind === "prop")
        .map(ref => ({ materialId: null as string | null, mediaId: ref.mediaId, version: ref.version })) : []);
    if (!refs.length) return;
    const styleRefs = refs.filter(ref => ref.styleKey);
    const materialRefs = refs.filter(ref => !ref.styleKey);
    if (styleRefs.length) {
      const { rows } = await db.query<{ styleKey: string; mediaId: string }>(
        `SELECT style_key AS "styleKey", media_id AS "mediaId" FROM ${namespace}.cd_style_presets WHERE owner_id=$1 AND style_key=ANY($2::text[]) ORDER BY style_key FOR SHARE`,
        [owner, [...new Set(styleRefs.map(ref => ref.styleKey!))]],
      );
      for (const ref of styleRefs) {
        if (!rows.some(row => row.styleKey === ref.styleKey && row.mediaId === ref.mediaId)) {
          throw new ComicLibraryError("QUOTE_STALE", 409);
        }
      }
    }
    if (!materialRefs.length) return;
    const unique = new Map(materialRefs.map(ref => [`${ref.materialId ?? ""}:${ref.mediaId}:${!!ref.pinned}`, ref]));
    const materialIds = materialRefs.flatMap(ref => ref.materialId ? [ref.materialId] : []);
    if (materialIds.length) {
      await db.query(`SELECT id FROM ${namespace}.cd_materials WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [owner, materialIds]);
    }
    const { rows } = await db.query<{ materialId: string; mediaId: string; version: number; latestVersion: number; archived: boolean }>(
      `SELECT m.id AS "materialId", v.media_id AS "mediaId", v.version, (m.archived_at IS NOT NULL) AS archived,
        (SELECT max(all_v.version) FROM ${namespace}.cd_material_versions all_v
          WHERE all_v.owner_id=m.owner_id AND all_v.material_id=m.id) AS "latestVersion"
      FROM ${namespace}.cd_materials m
      JOIN ${namespace}.cd_material_versions v ON (m.owner_id,m.id)=(v.owner_id,v.material_id)
      WHERE m.owner_id=$1 AND v.media_id=ANY($2::uuid[])
      ORDER BY v.version DESC`,
      [owner, [...new Set([...unique.values()].map(item => item.mediaId))]],
    );
    for (const ref of unique.values()) {
      const match = rows.find(row => row.mediaId === ref.mediaId && (!ref.materialId || row.materialId === ref.materialId));
      if (!match || match.archived || match.version !== ref.version || (!ref.pinned && match.latestVersion !== ref.version)) {
        throw new ComicLibraryError("QUOTE_STALE", 409);
      }
    }
  }

  async imageTake(owner: string, id: string): Promise<ComicImageTake & { taskId: string; slot: number }> {
    const { rows } = await this.pool.query<ComicImageTake & { taskId: string; slot: number }>(`SELECT ${takeColumns},
      job.id AS "taskId", t.slot ${joinTakes}
      WHERE t.owner_id=$1 AND t.id=$2 AND t.video_version IS NULL`, [owner, id]);
    return rows[0] ?? libraryMissing();
  }

  async isImageTakeStopped(owner: string, id: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ stopped: boolean }>(
      `SELECT (cancel_requested_at IS NOT NULL OR status NOT IN ('pending','running','recoverable')) AS stopped
       FROM ${namespace}.cd_takes WHERE owner_id=$1 AND id=$2 AND video_version IS NULL`,
      [owner, id],
    );
    return !rows[0] || rows[0].stopped;
  }

  async cancelImageTake(owner: string, id: string, taskId: string) {
    await libraryTransaction(this.pool, async db => {
      const parent = await db.query<{ status: string }>(
        "SELECT status FROM tasks WHERE id=$1 AND user_id=$2 AND type=$3 FOR UPDATE", [taskId, owner, COMIC_IMAGE_TASK],
      );
      if (!parent.rowCount) libraryMissing();
      const { rows: [row] } = await db.query<{ status: string; slot: number; receiptState: string | null }>(`SELECT t.status, t.slot,
        (SELECT r.state FROM image_call_receipts r WHERE r.task_id=$3 AND r.user_id=t.owner_id::text AND r.slot=t.slot) AS "receiptState"
        FROM ${namespace}.cd_takes t JOIN ${namespace}.cd_generation_requests req ON (req.owner_id,req.id)=(t.owner_id,t.request_id)
        WHERE t.owner_id=$1 AND t.id=$2 AND req.task_id=$3 AND t.video_version IS NULL FOR UPDATE OF t`, [owner, id, taskId]);
      if (!row) libraryMissing();
      if (row.status === "cancelled") return;
      if (!["pending", "running", "recoverable"].includes(row.status)
        || row.receiptState === "submitting" || row.receiptState === "unknown") {
        throw new ComicLibraryError("TAKE_NOT_CANCELLABLE", 409);
      }
      const taskActive = parent.rows[0].status === "pending" || parent.rows[0].status === "running";
      const settleImmediately = (!row.receiptState && (row.status === "pending" || !taskActive))
        || (row.status === "recoverable" && !taskActive);
      await db.query(`UPDATE ${namespace}.cd_takes SET cancel_requested_at=coalesce(cancel_requested_at,now()),
        status=CASE WHEN $3 THEN 'cancelled' ELSE status END,
        error=CASE WHEN $3 THEN NULL ELSE error END
        WHERE owner_id=$1 AND id=$2 AND video_version IS NULL`, [owner, id, settleImmediately]);
      await db.query(`UPDATE tasks job SET status='cancelled',updated_at=now() WHERE job.id=$1 AND job.status='pending' AND NOT EXISTS (
        SELECT 1 FROM ${namespace}.cd_generation_requests r JOIN ${namespace}.cd_takes t ON (t.owner_id,t.request_id)=(r.owner_id,r.id)
        WHERE r.task_id=job.id AND t.status IN ('pending','running'))`, [taskId]);
    });
  }

  async releaseImageTake(owner: string, id: string, taskId: string) {
    await libraryTransaction(this.pool, async db => {
      if (!await this.tryTaskLock(db, taskId)) throw new ComicLibraryError("TAKE_NOT_RELEASABLE", 409);
      const { rows: [row] } = await db.query<{ status: string; taskStatus: string; receiptState: string | null }>(`SELECT t.status,
        job.status AS "taskStatus",
        (SELECT r.state FROM image_call_receipts r WHERE r.task_id=job.id AND r.user_id=t.owner_id::text AND r.slot=t.slot) AS "receiptState"
        FROM ${namespace}.cd_takes t
        JOIN ${namespace}.cd_generation_requests req ON (req.owner_id,req.id)=(t.owner_id,t.request_id)
        JOIN tasks job ON job.id=req.task_id AND job.user_id=req.owner_id::text
        WHERE t.owner_id=$1 AND t.id=$2 AND job.id=$3 AND t.video_version IS NULL FOR UPDATE OF t`, [owner, id, taskId]);
      if (!row) libraryMissing();
      if (row.status === "released") return;
      const taskFinished = row.taskStatus !== "pending" && row.taskStatus !== "running";
      const isUnknown = row.status === "unknown"
        || (["pending", "running", "recoverable"].includes(row.status)
          && (row.receiptState === "submitting" || row.receiptState === "unknown"));
      if (!taskFinished || !isUnknown) throw new ComicLibraryError("TAKE_NOT_RELEASABLE", 409);
      await db.query(`UPDATE ${namespace}.cd_takes SET status='released', error='SUBMISSION_RELEASED'
        WHERE owner_id=$1 AND id=$2 AND video_version IS NULL`, [owner, id]);
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
      } else if ("materialId" in input) {
        const material = await db.query(`SELECT 1 FROM ${namespace}.cd_materials WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [owner, input.materialId]);
        if (!material.rowCount) libraryMissing();
      }
      const row = await db.query(`SELECT 1 FROM ${namespace}.cd_takes t WHERE owner_id=$1 AND id=$2 AND ${incomplete} FOR UPDATE`, [owner, take.id]);
      if (!row.rowCount) throw new ComicLibraryError("TAKE_NOT_WRITABLE", 409);
      await insertComicMedia(db, media);
      if ("characterId" in input) {
        await insertComicCharacterVersion(db, owner, input.characterId, input.target, media.id);
      } else if ("materialId" in input) {
        await insertComicMaterialVersion(db, owner, input.materialId, media.id);
      }
      await db.query(`UPDATE ${namespace}.cd_takes SET status='ready',media_id=$3,progress=100,error=NULL,completed_at=now() WHERE owner_id=$1 AND id=$2`,
        [owner, take.id, media.id]);
    });
  }

  async pruneExpiredQuotes() {
    await this.pool.query(`DELETE FROM ${namespace}.cd_materials m WHERE (m.owner_id,m.id) IN (
      SELECT q.owner_id,q.material_id FROM ${namespace}.cd_generation_requests q
      WHERE q.frozen->>'newMaterial'='true' AND q.confirmed_at IS NULL AND q.expires_at<now()-interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM ${namespace}.cd_generation_requests other
        WHERE (other.owner_id,other.material_id)=(q.owner_id,q.material_id) AND other.id<>q.id)
      AND NOT EXISTS (SELECT 1 FROM ${namespace}.cd_material_versions v WHERE (v.owner_id,v.material_id)=(q.owner_id,q.material_id))
      LIMIT 500 FOR UPDATE OF q SKIP LOCKED)`);
    await this.pool.query(`DELETE FROM ${namespace}.cd_generation_requests WHERE id IN
      (SELECT id FROM ${namespace}.cd_generation_requests WHERE confirmed_at IS NULL AND expires_at<now()-interval '1 day'
        AND frozen->>'newMaterial' IS DISTINCT FROM 'true' LIMIT 500 FOR UPDATE SKIP LOCKED)`);
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
