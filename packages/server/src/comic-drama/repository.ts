import type { Pool, PoolClient } from "pg";
import {
  comicDramaClipSchema, comicDramaIdSchema, comicDramaSeriesSchema, type ComicClipProgress, type ComicDramaClip, type ComicDramaClipDraft,
  type ComicDramaClipUpdate, type ComicCastChange, type ComicDramaContent, type ComicDramaDetail, type ComicDramaEpisodeSummary,
  type ComicDramaListQuery, type ComicDramaListing, type ComicDramaReorder, type ComicDramaRepository, type ComicDramaScriptVersion,
  type ComicDramaSeries, type ComicDramaSeriesInput, type ComicDramaSeriesStatus, type ComicDramaSeriesUpdate, type ComicSeriesCast,
} from "@lot-agent/core/comic-drama";

import { editSeriesCast, readSeriesCast, requireClipCast } from "./cast-store.js";
import { readComicDictionary, requireComicChoice } from "./dictionary.js";
import { comicQuoteCurrency } from "./pricing.js";

export type ComicEpisodeCostEstimator = (
  owner: string,
  videoModel: string | null,
) => Promise<{ imageMicros: number | null; videoPerSecMicros: number | null; currency: "CNY" | "USD" }>;

const seriesFields = `id, parent_id AS "parentId", title, logline, series_group AS "seriesGroup", episode_no AS "episodeNo",
  style_key AS "styleKey", aspect_ratio AS "aspectRatio", video_model AS "videoModel", revision, archived_at AS "archivedAt"`;
const clipFields = "id, revision, ordinal, draft";
type SeriesRow = Omit<ComicDramaSeries, "archivedAt"> & { archivedAt: Date | null };
const asSeries = (row: SeriesRow) => comicDramaSeriesSchema.parse({ ...row, archivedAt: row.archivedAt?.toISOString() ?? null });

export class ComicDramaError extends Error {
  constructor(readonly code: "NOT_FOUND" | "REVISION_CONFLICT" | "INVALID_ORDER" | "INVALID_CURSOR", readonly currentRevision?: number) {
    super(code);
  }
}

function requireRevision(current: number, expected: number) {
  if (current !== expected) throw new ComicDramaError("REVISION_CONFLICT", current);
}

type ClipMetaRow = {
  clipId: string;
  keyframeTakeId: string | null;
  keyframeMediaId: string | null;
  adoptedVideoTakeId: string | null;
  keyframeTakeState: string | null;
  keyframeTakeMediaId: string | null;
  keyframeTakeRev: number | null;
  latestImageState: string | null;
  latestVideoState: string | null;
  videoTakeCount: number;
  readyVideoCount: number;
  adoptedVersion: number | null;
  adoptedMediaId: string | null;
  adoptedClipRev: number | null;
  adoptedRefs: unknown;
};

type SpendRow = {
  amountMicros: number | null;
  unit: string | null;
  durationMs: number | null;
  status: string;
  currency: string | null;
};

function isCastSnapshotStale(refs: unknown, cast: readonly ComicSeriesCast[]): boolean {
  if (!Array.isArray(refs) || !cast.length) return false;
  for (const raw of refs) {
    if (!raw || typeof raw !== "object") continue;
    const ref = raw as { kind?: string; characterId?: string; label?: string; version?: number; mediaId?: string };
    if ((ref.kind !== "appearance" && ref.kind !== "expression") || !ref.characterId || !ref.label) continue;
    const member = cast.find(entry => entry.snapshot.characterId === ref.characterId);
    if (!member) continue;
    const assetKind = ref.kind === "appearance" ? "slot" : "expression";
    const asset = member.snapshot.assets.find(item => item.kind === assetKind && item.key === ref.label);
    if (!asset || asset.version !== ref.version || asset.media.id !== ref.mediaId) return true;
  }
  return false;
}

export class PgComicDramaRepository implements ComicDramaRepository {
  constructor(private readonly pool: Pool, private readonly costEstimator?: ComicEpisodeCostEstimator) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async series(client: PoolClient, owner: string, id: string, writable = false) {
    const { rows } = await client.query<SeriesRow>(
      `SELECT ${seriesFields} FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL
        ${writable ? "AND archived_at IS NULL FOR UPDATE" : ""}`, [owner, id],
    );
    if (!rows[0]) throw new ComicDramaError("NOT_FOUND");
    return asSeries(rows[0]);
  }

  private async attachProgress(
    client: PoolClient, owner: string, seriesId: string, clips: ComicDramaClip[], cast: readonly ComicSeriesCast[],
  ): Promise<{ clips: ComicDramaClip[]; completedCount: number; generatingCount: number }> {
    if (!clips.length) return { clips, completedCount: 0, generatingCount: 0 };
    const { rows } = await client.query<ClipMetaRow>(`SELECT
        c.id AS "clipId",
        c.keyframe_take_id AS "keyframeTakeId",
        c.keyframe_media_id AS "keyframeMediaId",
        c.adopted_video_take_id AS "adoptedVideoTakeId",
        kt.status AS "keyframeTakeState",
        kt.media_id AS "keyframeTakeMediaId",
        (kt.input->>'clipRevision')::int AS "keyframeTakeRev",
        (SELECT t.status FROM lot_comic_drama.cd_takes t
          WHERE t.owner_id=$1 AND t.target_id=c.id AND t.video_version IS NULL
          ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS "latestImageState",
        (SELECT t.status FROM lot_comic_drama.cd_takes t
          WHERE t.owner_id=$1 AND t.target_id=c.id AND t.video_version IS NOT NULL
          ORDER BY t.video_version DESC LIMIT 1) AS "latestVideoState",
        (SELECT count(*)::int FROM lot_comic_drama.cd_takes t
          WHERE t.owner_id=$1 AND t.target_id=c.id AND t.video_version IS NOT NULL) AS "videoTakeCount",
        (SELECT count(*)::int FROM lot_comic_drama.cd_takes t
          WHERE t.owner_id=$1 AND t.target_id=c.id AND t.video_version IS NOT NULL AND t.status='ready') AS "readyVideoCount",
        av.video_version AS "adoptedVersion",
        av.media_id AS "adoptedMediaId",
        (av.input->>'clipRevision')::int AS "adoptedClipRev",
        av.input->'references' AS "adoptedRefs"
      FROM lot_comic_drama.cd_clips c
      LEFT JOIN lot_comic_drama.cd_takes kt ON kt.owner_id=$1 AND kt.id=c.keyframe_take_id
      LEFT JOIN lot_comic_drama.cd_takes av ON av.owner_id=$1 AND av.id=c.adopted_video_take_id
      WHERE c.series_id=$2`, [owner, seriesId]);
    const byId = new Map(rows.map(row => [row.clipId, row]));
    let completedCount = 0;
    const { rows: [genRow] } = await client.query<{ generating: number }>(
      `SELECT count(DISTINCT t.target_id)::int AS generating
       FROM lot_comic_drama.cd_takes t
       JOIN lot_comic_drama.cd_generation_requests r ON (r.owner_id, r.id) = (t.owner_id, t.request_id)
       WHERE r.owner_id=$1 AND r.series_id=$2 AND t.status IN ('pending', 'running')`,
      [owner, seriesId],
    );
    const asState = (value: string | null): ComicClipProgress["keyframeState"] => {
      if (value === "pending" || value === "running" || value === "ready" || value === "failed" ||
        value === "recoverable" || value === "unknown") return value;
      return "none";
    };
    const enriched = clips.map(clip => {
      const meta = byId.get(clip.id);
      if (!meta) return clip;
      if (meta.readyVideoCount > 0) completedCount += 1;
      const takeApproved = !!meta.keyframeTakeId && meta.keyframeTakeState === "ready" && meta.keyframeTakeRev === clip.revision;
      const manualApproved = !meta.keyframeTakeId && !!meta.keyframeMediaId;
      const keyframeApproved = takeApproved || manualApproved;
      const keyframeMediaId = takeApproved ? meta.keyframeTakeMediaId : manualApproved ? meta.keyframeMediaId : meta.keyframeTakeMediaId;
      const keyframeStale = !!meta.keyframeTakeId && meta.keyframeTakeState === "ready" && meta.keyframeTakeRev !== clip.revision;
      const progress: ComicClipProgress = {
        keyframeState: keyframeApproved ? "ready" : asState(meta.latestImageState),
        keyframeMediaId: keyframeMediaId ?? null,
        keyframeApproved,
        keyframeStale,
        videoState: meta.adoptedVideoTakeId ? "ready" : asState(meta.latestVideoState),
        videoTakeCount: meta.videoTakeCount,
        adoptedVideoTakeId: meta.adoptedVideoTakeId,
        adoptedVideoVersion: meta.adoptedVersion,
        adoptedVideoMediaId: meta.adoptedMediaId,
        adoptedStale: !!meta.adoptedVideoTakeId && meta.adoptedClipRev !== null && meta.adoptedClipRev !== clip.revision,
        castSnapshotStale: isCastSnapshotStale(meta.adoptedRefs, cast),
      };
      return { ...clip, progress };
    });
    return { clips: enriched, completedCount, generatingCount: genRow?.generating ?? 0 };
  }

  private async buildSummary(
    client: PoolClient, owner: string, series: ComicDramaSeries, clips: ComicDramaClip[], completedCount: number, generatingCount: number,
  ): Promise<ComicDramaEpisodeSummary> {
    const { rows: spendRows } = await client.query<SpendRow>(
      `SELECT (r.frozen->'price'->>'amountMicros')::double precision AS "amountMicros",
         r.frozen->'price'->>'unit' AS unit,
         (t.input->>'durationMs')::int AS "durationMs",
         t.status,
         r.frozen->'price'->>'currency' AS currency
       FROM lot_comic_drama.cd_takes t
       JOIN lot_comic_drama.cd_generation_requests r ON (r.owner_id, r.id) = (t.owner_id, t.request_id)
       WHERE r.owner_id=$1 AND r.series_id=$2 AND r.confirmed_at IS NOT NULL`,
      [owner, series.id],
    );
    let spentMicros = 0;
    let spentUnverifiedCount = 0;
    let currency: "CNY" | "USD" = comicQuoteCurrency();
    for (const row of spendRows) {
      if (row.currency === "USD" || row.currency === "CNY") currency = row.currency;
      if (row.status === "unknown") {
        spentUnverifiedCount += 1;
        continue;
      }
      if (row.status !== "ready") continue;
      if (typeof row.amountMicros === "number" && Number.isFinite(row.amountMicros)) {
        const qty = row.unit === "second" && row.durationMs ? row.durationMs / 1000 : 1;
        spentMicros += Math.round(row.amountMicros * qty);
      } else {
        spentUnverifiedCount += 1;
      }
    }
    const estimate = this.costEstimator ? await this.costEstimator(owner, series.videoModel).catch(() => null) : null;
    if (estimate) currency = estimate.currency;
    let estimatedMicros: number | null = 0;
    let estimatedUnverifiedCount = 0;
    for (const clip of clips) {
      const hasReadyVideo = clip.progress?.videoState === "ready";
      const hasApprovedFrame = !!clip.progress?.keyframeApproved;
      if (!hasApprovedFrame) {
        if (estimate && estimate.imageMicros !== null) {
          if (estimatedMicros !== null) estimatedMicros += estimate.imageMicros;
        } else {
          estimatedMicros = null;
          estimatedUnverifiedCount += 1;
        }
      }
      if (!hasReadyVideo) {
        if (estimate && estimate.videoPerSecMicros !== null) {
          if (estimatedMicros !== null) estimatedMicros += Math.round(estimate.videoPerSecMicros * (clip.draft.durationMs / 1000));
        } else {
          estimatedMicros = null;
          estimatedUnverifiedCount += 1;
        }
      }
    }
    return {
      seriesId: series.id,
      title: series.title,
      archived: !!series.archivedAt,
      clipCount: clips.length,
      completedCount,
      generatingCount,
      totalDurationMs: clips.reduce((sum, clip) => sum + clip.draft.durationMs, 0),
      estimatedMicros,
      estimatedUnverifiedCount,
      spentMicros,
      spentUnverifiedCount,
      currency,
    };
  }

  private async content(client: PoolClient, id: string, seriesRevision: number): Promise<ComicDramaContent> {
    const clips = await client.query(`SELECT ${clipFields} FROM lot_comic_drama.cd_clips WHERE series_id=$1 ORDER BY ordinal`, [id]);
    const script = await client.query("SELECT version, content FROM lot_comic_drama.cd_scripts WHERE series_id=$1 ORDER BY version DESC LIMIT 1", [id]);
    return { seriesRevision, clips: clips.rows.map(row => comicDramaClipSchema.parse(row)), script: script.rows[0] ?? null,
      cast: await readSeriesCast(client, id) };
  }

  async list(owner: string, { query, archived, status, seriesGroup, cursor }: ComicDramaListQuery): Promise<ComicDramaListing> {
    const [at, id] = cursor?.split(",") ?? [];
    if (cursor && (cursor.split(",").length !== 2 || !Number.isFinite(Date.parse(at)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicDramaError("INVALID_CURSOR");
    }
    type ListRow = SeriesRow & {
      updatedAt: Date; clipCount: number; hasRender: boolean; coverMediaId: string | null;
      completedCount: number; generatingCount: number; hasTakes: boolean;
    };
    const { rows } = await this.pool.query<ListRow>(
      `WITH base AS (
        SELECT ${seriesFields}, updated_at AS "updatedAt",
          (SELECT count(*)::int FROM lot_comic_drama.cd_clips WHERE series_id=series.id) AS "clipCount",
          EXISTS (SELECT 1 FROM lot_comic_drama.cd_renders r WHERE (r.owner_id,r.series_id)=(series.owner_id,series.id)
            AND r.media_id IS NOT NULL) AS "hasRender",
          (SELECT coalesce(c.keyframe_media_id, kt.media_id)
            FROM lot_comic_drama.cd_clips c
            LEFT JOIN lot_comic_drama.cd_takes kt ON kt.owner_id=series.owner_id AND kt.id=c.keyframe_take_id AND kt.status='ready'
            WHERE c.series_id=series.id AND (c.keyframe_media_id IS NOT NULL OR kt.media_id IS NOT NULL)
            ORDER BY (c.adopted_video_take_id IS NOT NULL) DESC, c.ordinal ASC LIMIT 1) AS "coverMediaId",
          (SELECT count(DISTINCT c.id)::int FROM lot_comic_drama.cd_clips c
            WHERE c.series_id=series.id AND EXISTS (
              SELECT 1 FROM lot_comic_drama.cd_takes t
              WHERE t.owner_id=series.owner_id AND t.target_id=c.id AND t.video_version IS NOT NULL AND t.status='ready'
            )) AS "completedCount",
          (SELECT count(DISTINCT t.target_id)::int FROM lot_comic_drama.cd_takes t
            JOIN lot_comic_drama.cd_generation_requests gr ON (gr.owner_id,gr.id)=(t.owner_id,t.request_id)
            WHERE gr.owner_id=series.owner_id AND gr.series_id=series.id AND t.status IN ('pending','running')) AS "generatingCount",
          EXISTS (SELECT 1 FROM lot_comic_drama.cd_generation_requests gr
            WHERE gr.owner_id=series.owner_id AND gr.series_id=series.id AND gr.confirmed_at IS NOT NULL) AS "hasTakes"
        FROM lot_comic_drama.cd_series AS series WHERE owner_id=$1 AND deleted_at IS NULL AND (archived_at IS NOT NULL)=$2
        AND (strpos(lower(title),lower($3))>0 OR strpos(lower(coalesce(series_group,'')),lower($3))>0 OR $3='')
        AND ($6::text IS NULL OR series_group=$6)
        AND ($4::timestamptz IS NULL OR (updated_at,id)<($4::timestamptz,$5::uuid))
      )
      SELECT * FROM base
      WHERE ($7::text IS NULL OR (CASE WHEN "hasRender" THEN 'exported' WHEN "completedCount">0 OR "generatingCount">0 OR "hasTakes" THEN 'in_progress' ELSE 'draft' END)=$7)
      ORDER BY "updatedAt" DESC, id DESC LIMIT 25`,
      [owner, archived === "true", query ?? "", at ?? null, id ?? null, seriesGroup ?? null, status ?? null],
    );
    const entries = rows.slice(0, 24).map(({ updatedAt, clipCount, hasRender, coverMediaId, completedCount, generatingCount, hasTakes, ...row }) => {
      const derivedStatus: ComicDramaSeriesStatus = hasRender ? "exported"
        : completedCount > 0 || generatingCount > 0 || hasTakes ? "in_progress" : "draft";
      return {
        ...asSeries(row),
        updatedAt: updatedAt.toISOString(),
        clipCount,
        hasRender,
        coverMediaId,
        completedCount,
        generatingCount,
        status: derivedStatus,
      };
    });
    const last = entries.at(-1);
    return { entries, nextCursor: rows.length > 24 && last ? `${last.updatedAt},${last.id}` : null };
  }

  get(owner: string, id: string): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id);
      const { clips: rawClips, script, cast } = await this.content(client, id, series.revision);
      const { clips, completedCount, generatingCount } = await this.attachProgress(client, owner, id, rawClips, cast);
      const summary = await this.buildSummary(client, owner, series, clips, completedCount, generatingCount);
      return { series, clips, script, cast, summary };
    }, true);
  }

  async current(owner: string): Promise<string | null> {
    const { rows } = await this.pool.query("SELECT current_series_id FROM lot_comic_drama.cd_user_state WHERE owner_id=$1", [owner]);
    return rows[0]?.current_series_id ?? null;
  }

  async currentSummary(owner: string): Promise<{ seriesId: string | null; summary: ComicDramaEpisodeSummary | null }> {
    const seriesId = await this.current(owner);
    if (!seriesId) return { seriesId: null, summary: null };
    try {
      const detail = await this.get(owner, seriesId);
      return { seriesId, summary: detail.summary ?? null };
    } catch {
      return { seriesId: null, summary: null };
    }
  }

  private async setCurrent(client: PoolClient, owner: string, id: string) {
    await client.query(`INSERT INTO lot_comic_drama.cd_user_state(owner_id,current_series_id) VALUES ($1,$2)
      ON CONFLICT (owner_id) DO UPDATE SET current_series_id=excluded.current_series_id`, [owner, id]);
  }

  open(owner: string, id: string): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id, true);
      await this.setCurrent(client, owner, id);
      const { clips: rawClips, script, cast } = await this.content(client, id, series.revision);
      const { clips, completedCount, generatingCount } = await this.attachProgress(client, owner, id, rawClips, cast);
      const summary = await this.buildSummary(client, owner, series, clips, completedCount, generatingCount);
      return { series, clips, script, cast, summary };
    });
  }

  private async insert(client: PoolClient, owner: string, fields: ComicDramaSeriesInput, parentId: string | null = null) {
    const { title, logline = "", seriesGroup = null, episodeNo = null, styleKey, aspectRatio, videoModel } = fields;
    const { rows } = await client.query<SeriesRow>(`INSERT INTO lot_comic_drama.cd_series
      (owner_id,parent_id,title,logline,series_group,episode_no,style_key,aspect_ratio,video_model)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${seriesFields}`,
      [owner, parentId, title, logline, seriesGroup, episodeNo, styleKey, aspectRatio, videoModel]);
    return asSeries(rows[0]);
  }

  create(owner: string, fields: ComicDramaSeriesInput): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      let styleKey = fields.styleKey;
      let parentId: string | null = null;
      const inherit = fields.inheritCastAndStyle !== false;
      if (fields.sourceSeriesId) {
        const source = await this.series(client, owner, fields.sourceSeriesId);
        parentId = source.id;
        if (inherit) styleKey = source.styleKey;
      }
      await requireComicChoice(client, owner, "style", styleKey);
      const series = await this.insert(client, owner, { ...fields, styleKey }, parentId);
      if (parentId && inherit) {
        await client.query(`INSERT INTO lot_comic_drama.cd_series_cast(owner_id,series_id,character_id,outfit_id,snapshot)
          SELECT owner_id,$1,character_id,outfit_id,snapshot FROM lot_comic_drama.cd_series_cast WHERE owner_id=$2 AND series_id=$3`,
          [series.id, owner, parentId]);
      }
      await this.setCurrent(client, owner, series.id);
      const cast = parentId && inherit ? await readSeriesCast(client, series.id) : [];
      const summary = await this.buildSummary(client, owner, series, [], 0, 0);
      return { series, clips: [], script: null, cast, summary };
    });
  }

  derive(owner: string, id: string, sequel: boolean, inheritCastAndStyle = true): Promise<ComicDramaDetail> {
    return this.transaction(client => this.deriveOn(client, owner, id, sequel, inheritCastAndStyle));
  }

  async deriveOn(client: PoolClient, owner: string, id: string, sequel: boolean, inheritCastAndStyle = true): Promise<ComicDramaDetail> {
      const source = await this.series(client, owner, id, true);
      const seriesGroup = source.seriesGroup ?? source.title;
      const episodeNo = sequel ? Math.min((source.episodeNo ?? 1) + 1, 2_147_483_647) : source.episodeNo;
      const suffix = sequel ? ` #${episodeNo}` : " (copy)";
      const title = (sequel ? seriesGroup : source.title).slice(0, 120 - suffix.length).replace(/[\uD800-\uDBFF]$/u, "") + suffix;
      const inherit = !sequel || inheritCastAndStyle;
      const styleKey = inherit ? source.styleKey :
        (await readComicDictionary(client, owner, "style")).find(style => !style.inactive)?.key ?? "thick_painting";
      const series = await this.insert(client, owner, {
        ...source, styleKey, title, episodeNo, seriesGroup: sequel ? seriesGroup : source.seriesGroup, logline: sequel ? "" : source.logline,
      }, sequel ? id : source.parentId);
      if (inherit) {
        await client.query(`INSERT INTO lot_comic_drama.cd_series_cast(owner_id,series_id,character_id,outfit_id,snapshot)
          SELECT owner_id,$1,character_id,outfit_id,snapshot FROM lot_comic_drama.cd_series_cast WHERE owner_id=$2 AND series_id=$3`,
          [series.id, owner, id]);
      }
      if (!sequel) {
        await client.query("INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft) SELECT $1,ordinal,draft FROM lot_comic_drama.cd_clips WHERE series_id=$2", [series.id, id]);
        await client.query(`INSERT INTO lot_comic_drama.cd_scripts(series_id,version,content,source)
          SELECT $1,1,content,source FROM lot_comic_drama.cd_scripts WHERE series_id=$2 ORDER BY version DESC LIMIT 1`, [series.id, id]);
      }
      await this.setCurrent(client, owner, series.id);
      const { clips, script, cast } = await this.content(client, series.id, series.revision);
      return { series, clips, script, cast };
  }

  async writeBreakdown(client: PoolClient, owner: string, id: string, expected: number, drafts: ComicDramaClipDraft[], replace: boolean) {
    const series = await this.series(client, owner, id, true);
    requireRevision(series.revision, expected);
    // Generation takes and edit/render references remain attached to their original immutable take IDs.
    if (replace) await client.query("DELETE FROM lot_comic_drama.cd_clips WHERE series_id=$1", [id]);
    await client.query(`INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft)
      SELECT $1,(SELECT coalesce(max(ordinal),0) FROM lot_comic_drama.cd_clips WHERE series_id=$1)+d.ordinal,d.draft
      FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS d(draft,ordinal)`, [id, JSON.stringify(drafts)]);
    return this.bump(client, id);
  }

  update(owner: string, id: string, fields: ComicDramaSeriesUpdate): Promise<ComicDramaSeries> {
    return this.transaction(async client => {
      const current = await this.series(client, owner, id, true);
      requireRevision(current.revision, fields.expectedRevision);
      if (current.styleKey !== fields.styleKey) await requireComicChoice(client, owner, "style", fields.styleKey);
      const { title, logline, seriesGroup, episodeNo, styleKey, aspectRatio, videoModel } = fields;
      const { rows } = await client.query<SeriesRow>(`UPDATE lot_comic_drama.cd_series SET title=$2,logline=$3,series_group=$4,episode_no=$5,
        style_key=$6,aspect_ratio=$7,video_model=$8,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${seriesFields}`,
        [id, title, logline, seriesGroup, episodeNo, styleKey, aspectRatio, videoModel]);
      return asSeries(rows[0]);
    });
  }

  private async hide(owner: string, id: string, expected: number, column: "archived_at" | "deleted_at") {
    await this.transaction(async client => {
      // Lock archived rows too so they can still be deleted from history.
      const result = await client.query("SELECT revision FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [owner, id]);
      if (!result.rows[0]) throw new ComicDramaError("NOT_FOUND");
      requireRevision(result.rows[0].revision, expected);
      await client.query(`UPDATE lot_comic_drama.cd_series SET ${column}=now(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [id]);
      await client.query("UPDATE lot_comic_drama.cd_user_state SET current_series_id=NULL WHERE owner_id=$1 AND current_series_id=$2", [owner, id]);
    });
  }

  archive(owner: string, id: string, expected: number) { return this.hide(owner, id, expected, "archived_at"); }
  remove(owner: string, id: string, expected: number) { return this.hide(owner, id, expected, "deleted_at"); }

  private async bump(client: PoolClient, id: string): Promise<number> {
    const { rows } = await client.query("UPDATE lot_comic_drama.cd_series SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING revision", [id]);
    return rows[0].revision;
  }

  private editContent(owner: string, id: string, expected: number, edit: (client: PoolClient) => Promise<unknown>) {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id, true);
      requireRevision(series.revision, expected);
      await edit(client);
      return this.content(client, id, await this.bump(client, id));
    });
  }

  readCast(owner: string, id: string) {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id);
      return { cast: await readSeriesCast(client, id), seriesRevision: series.revision };
    }, true);
  }

  changeCast(owner: string, id: string, expected: number, change: ComicCastChange) {
    return this.editContent(owner, id, expected, client => editSeriesCast(client, owner, id, change));
  }

  scriptHistory(owner: string, id: string): Promise<ComicDramaScriptVersion[]> {
    return this.transaction(async client => {
      await this.series(client, owner, id);
      const { rows } = await client.query<{ version: number; content: string; source: "user" | "assistant"; createdAt: Date }>(
        `SELECT version, content, source, created_at AS "createdAt" FROM lot_comic_drama.cd_scripts
         WHERE series_id=$1 ORDER BY version DESC LIMIT 50`,
        [id],
      );
      return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
    }, true);
  }

  saveScript(owner: string, id: string, expected: number, content: string) {
    return this.transaction(async client => {
      const revision = await this.writeScript(client, owner, id, expected, content, "user");
      return this.content(client, id, revision);
    });
  }

  async writeScript(client: PoolClient, owner: string, id: string, expected: number, content: string, source: "user" | "assistant") {
    const series = await this.series(client, owner, id, true);
    requireRevision(series.revision, expected);
    await client.query(`INSERT INTO lot_comic_drama.cd_scripts(series_id,version,content,source)
      SELECT $1,coalesce(max(version),0)+1,$2,$3 FROM lot_comic_drama.cd_scripts WHERE series_id=$1`, [id, content, source]);
    return this.bump(client, id);
  }

  addClip(owner: string, id: string, expected: number, opts?: { afterClipId?: string; insertIndex?: number }) {
    const draft: ComicDramaClipDraft = { schemaVersion: 1, durationMs: 6000, scene: "", shots: [], lines: [] };
    return this.editContent(owner, id, expected, async client => {
      if (opts?.afterClipId) {
        const target = await this.clip(client, id, opts.afterClipId);
        await client.query("UPDATE lot_comic_drama.cd_clips SET ordinal=ordinal+1 WHERE series_id=$1 AND ordinal>$2", [id, target.ordinal]);
        await client.query("INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft) VALUES ($1,$2,$3)", [id, target.ordinal + 1, draft]);
        return;
      }
      if (typeof opts?.insertIndex === "number") {
        const { rows: [cnt] } = await client.query<{ max: number }>("SELECT coalesce(max(ordinal),0)::int AS max FROM lot_comic_drama.cd_clips WHERE series_id=$1", [id]);
        const targetOrdinal = Math.min(Math.max(1, opts.insertIndex + 1), cnt.max + 1);
        await client.query("UPDATE lot_comic_drama.cd_clips SET ordinal=ordinal+1 WHERE series_id=$1 AND ordinal>=$2", [id, targetOrdinal]);
        await client.query("INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft) VALUES ($1,$2,$3)", [id, targetOrdinal, draft]);
        return;
      }
      await client.query(`INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft)
        SELECT $1,coalesce(max(ordinal),0)+1,$2 FROM lot_comic_drama.cd_clips WHERE series_id=$1`, [id, draft]);
    });
  }

  private async clip(client: PoolClient, id: string, clipId: string): Promise<ComicDramaClip> {
    const { rows } = await client.query(`SELECT ${clipFields} FROM lot_comic_drama.cd_clips WHERE series_id=$1 AND id=$2`, [id, clipId]);
    if (!rows[0]) throw new ComicDramaError("NOT_FOUND");
    return comicDramaClipSchema.parse(rows[0]);
  }

  saveClip(owner: string, id: string, clipId: string, { expectedRevision, draft }: ComicDramaClipUpdate) {
    return this.transaction(async client => {
      await this.series(client, owner, id, true);
      const existing = await this.clip(client, id, clipId);
      requireRevision(existing.revision, expectedRevision);
      const existingFramings = new Set(existing.draft.shots.map(shot => shot.framingKey));
      const existingMovements = new Set(existing.draft.shots.map(shot => shot.movementKey));
      const existingEmotions = new Set(existing.draft.lines.map(line => line.emotionKey).filter((key): key is string => Boolean(key)));
      for (const key of new Set(draft.shots.map(shot => shot.framingKey))) {
        if (!existingFramings.has(key)) await requireComicChoice(client, owner, "framing", key);
      }
      for (const key of new Set(draft.shots.map(shot => shot.movementKey))) {
        if (!existingMovements.has(key)) await requireComicChoice(client, owner, "movement", key);
      }
      for (const key of new Set(draft.lines.map(line => line.emotionKey).filter((value): value is string => Boolean(value)))) {
        if (!existingEmotions.has(key)) await requireComicChoice(client, owner, "emotion", key);
      }
      await requireClipCast(client, id, draft.cast);
      const { rows } = await client.query(`UPDATE lot_comic_drama.cd_clips SET draft=$2,revision=revision+1,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING ${clipFields}`, [clipId, draft]);
      return { clip: comicDramaClipSchema.parse(rows[0]), seriesRevision: await this.bump(client, id) };
    });
  }

  copyClip(owner: string, id: string, clipId: string, expected: number) {
    return this.editContent(owner, id, expected, async client => {
      const { ordinal, draft } = await this.clip(client, id, clipId);
      await client.query("UPDATE lot_comic_drama.cd_clips SET ordinal=ordinal+1 WHERE series_id=$1 AND ordinal>$2", [id, ordinal]);
      await client.query("INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft) VALUES ($1,$2,$3)", [id, ordinal + 1, draft]);
    });
  }

  removeClip(owner: string, id: string, clipId: string, expected: number) {
    return this.editContent(owner, id, expected, async client => {
      const { ordinal } = await this.clip(client, id, clipId);
      await client.query("DELETE FROM lot_comic_drama.cd_clips WHERE id=$1", [clipId]);
      await client.query("UPDATE lot_comic_drama.cd_clips SET ordinal=ordinal-1 WHERE series_id=$1 AND ordinal>$2", [id, ordinal]);
    });
  }

  reorder(owner: string, id: string, { expectedRevision, clipIds }: ComicDramaReorder) {
    return this.editContent(owner, id, expectedRevision, async client => {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM lot_comic_drama.cd_clips WHERE series_id=$1", [id]);
      const provided = new Set(clipIds);
      if (rows.length !== clipIds.length || rows.some(row => !provided.has(row.id))) throw new ComicDramaError("INVALID_ORDER");
      await client.query(`UPDATE lot_comic_drama.cd_clips SET ordinal=source.ordinal FROM unnest($2::uuid[]) WITH ORDINALITY AS source(clip_id,ordinal)
        WHERE series_id=$1 AND id=source.clip_id`, [id, clipIds]);
    });
  }
}
