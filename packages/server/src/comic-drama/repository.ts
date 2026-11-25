import type { Pool, PoolClient } from "pg";
import {
  buildComicDramaHierarchy, comicDramaClipSchema, comicDramaIdSchema, comicDramaSchema, comicDramaSeriesSchema,
  type ComicClipProgress, type ComicCurrencyAmount, type ComicDrama, type ComicDramaCastContent, type ComicDramaClip,
  type ComicDramaClipDraft, type ComicDramaClipUpdate, type ComicCastChange, type ComicDramaContent, type ComicDramaCreateInput,
  type ComicDramaCurrentState, type ComicDramaDetail, type ComicDramaEpisodeBrief, type ComicDramaEpisodeCreateInput,
  type ComicDramaEpisodeSummary, type ComicDramaHierarchyListQuery, type ComicDramaListQuery, type ComicDramaListing,
  type ComicDramaOption, type ComicDramaReorder, type ComicDramaRepository, type ComicDramaScriptVersion, type ComicDramaSeries, type ComicDramaSeriesInput,
  type ComicDramaSeriesStatus, type ComicDramaSeriesUpdate, type ComicDramaTreeEntry, type ComicDramaTreeListing,
  type ComicDramaUpdateInput, type ComicDramaView, type ComicEpisodeCostSummary, type ComicInvalidMaterialRef, type ComicSeriesCast,
} from "@lot-agent/core/comic-drama";

import {
  editDramaCast, editSeriesCast, readDramaCast, readSeriesCast, requireClipCast, syncDramaCastToSeries,
} from "./cast-store.js";
import { readComicDictionary, requireComicChoice } from "./dictionary.js";
import { comicBatchCreditPaused } from "./generation-repository.js";
import type { ComicQuery } from "./library-db.js";
import { comicQuoteCurrency } from "./pricing.js";

export type ComicEpisodeCostEstimate = {
  imageMicros: number | null;
  videoPerSecMicros: number | null;
  currency: "CNY" | "USD";
};

export type ComicEpisodeCostEstimator = (
  owner: string,
  videoModel: string | null,
  db?: ComicQuery,
) => Promise<ComicEpisodeCostEstimate>;

const dramaFields = `id, title, synopsis, outline, script_content AS "scriptContent",
  style_key AS "styleKey", aspect_ratio AS "aspectRatio", video_model AS "videoModel",
  revision, archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const seriesFields = `id, drama_id AS "dramaId", parent_id AS "parentId", title, logline, series_group AS "seriesGroup",
  episode_no AS "episodeNo", style_key AS "styleKey", aspect_ratio AS "aspectRatio", video_model AS "videoModel",
  revision, archived_at AS "archivedAt"`;
const clipFields = 'id, series_id AS "episodeId", revision, selection_revision AS "selectionRevision", ordinal, draft';
type DramaRow = Omit<ComicDrama, "archivedAt" | "createdAt" | "updatedAt"> & {
  archivedAt: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};
type SeriesRow = Omit<ComicDramaSeries, "archivedAt"> & { archivedAt: Date | null };
const asDrama = (row: DramaRow): ComicDrama => comicDramaSchema.parse({
  ...row,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  ...(row.createdAt ? { createdAt: row.createdAt.toISOString() } : {}),
  ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
});
const asSeries = (row: SeriesRow) => comicDramaSeriesSchema.parse({ ...row, archivedAt: row.archivedAt?.toISOString() ?? null });
const deriveEpisodeStatus = (hasRender: boolean, completedCount: number, generatingCount: number, hasTakes: boolean): ComicDramaSeriesStatus =>
  hasRender ? "exported" : completedCount > 0 || generatingCount > 0 || hasTakes ? "in_progress" : "draft";
const deriveDramaStatus = (
  episodeCount: number,
  exportedEpisodeCount: number,
  episodes: readonly Pick<ComicDramaEpisodeBrief, "status">[],
): ComicDramaSeriesStatus => {
  if (episodeCount > 0 && exportedEpisodeCount === episodeCount) return "exported";
  if (episodes.some(ep => ep.status === "in_progress" || ep.status === "exported")) return "in_progress";
  return "draft";
};

export class ComicDramaError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "REVISION_CONFLICT" | "INVALID_ORDER" | "INVALID_CURSOR" | "INVALID_MATERIAL_REFERENCE",
    readonly currentRevision?: number,
  ) {
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
  keyframeCandidateAvailable: boolean;
  latestImageState: string | null;
  latestVideoState: string | null;
  videoTakeCount: number;
  readyVideoCount: number;
  adoptedVersion: number | null;
  adoptedMediaId: string | null;
  adoptedClipRev: number | null;
  adoptedRefs: unknown;
};

export type EpisodeSpendRow = {
  amountMicros: number | null;
  quotedTotalMicros?: number | null;
  unit: string | null;
  durationMs: number | null;
  status: string;
  submitState?: string | null;
  error?: string | null;
  gatewayHttpStatus?: number | null;
  currency: string | null;
  settledAmountMicros?: string | number | null;
  settledCurrency?: string | null;
  settlementChecked?: boolean;
};

type MaterialRefEntry = {
  role: ComicInvalidMaterialRef["role"];
  materialId: string;
  mediaId: string;
  name?: string;
};

type MaterialCheckRow = {
  materialId: string;
  kind: string;
  archived: boolean;
  mediaId: string | null;
  mime: string | null;
  version: number | null;
  latestVersion: number | null;
};

const CURRENCY_ORDER: readonly ("CNY" | "USD")[] = ["CNY", "USD"];
const isCurrency = (value: unknown): value is "CNY" | "USD" => value === "CNY" || value === "USD";

function toCurrencyAmounts(totals: Map<"CNY" | "USD", number>): ComicCurrencyAmount[] {
  const result: ComicCurrencyAmount[] = [];
  for (const currency of CURRENCY_ORDER) {
    const amountMicros = totals.get(currency);
    if (amountMicros !== undefined) result.push({ currency, amountMicros });
  }
  return result;
}

/** Pure episode cost breakdown separating settled charges, unbilled quotes, remaining estimate and reconcile items per currency. */
export function summarizeEpisodeCosts(
  rows: readonly EpisodeSpendRow[],
  clips: readonly ComicDramaClip[],
  estimate: ComicEpisodeCostEstimate | null,
  defaultCurrency: "CNY" | "USD" = comicQuoteCurrency(),
): {
  costs: ComicEpisodeCostSummary;
  estimatedMicros: number | null;
  estimatedUnverifiedCount: number;
  spentMicros: number;
  spentUnverifiedCount: number;
  currency: "CNY" | "USD";
} {
  const settledTotals = new Map<"CNY" | "USD", number>();
  const quotedTotals = new Map<"CNY" | "USD", number>();
  let settledTakeCount = 0;
  let unbilledReadyCount = 0;
  let unbilledPendingCount = 0;
  let pendingReconcileCount = 0;

  for (const row of rows) {
    const parsedSettled = row.settledAmountMicros !== null && row.settledAmountMicros !== undefined
      ? Number(row.settledAmountMicros)
      : Number.NaN;
    if (Number.isFinite(parsedSettled) && parsedSettled >= 0 && isCurrency(row.settledCurrency)) {
      settledTotals.set(row.settledCurrency, (settledTotals.get(row.settledCurrency) ?? 0) + Math.round(parsedSettled));
      settledTakeCount += 1;
      continue;
    }

    const gateway5xx = row.error === "VIDEO_GATEWAY_FAILED"
      || (typeof row.gatewayHttpStatus === "number" && row.gatewayHttpStatus >= 500);
    const needsReconcile = row.status === "unknown"
      || row.status === "released"
      || row.status === "recoverable"
      || row.submitState === "unknown"
      || gateway5xx;
    if (needsReconcile) {
      pendingReconcileCount += 1;
      continue;
    }

    if (row.status !== "ready" && row.status !== "pending" && row.status !== "running") continue;
    const qty = row.unit === "second" && row.durationMs ? row.durationMs / 1000 : 1;
    const quote = row.quotedTotalMicros ?? (row.amountMicros === null ? null : Math.round(row.amountMicros * qty));
    const ready = row.status === "ready";
    if (ready) unbilledReadyCount++;
    if (quote !== null && Number.isFinite(quote) && isCurrency(row.currency)) {
      quotedTotals.set(row.currency, (quotedTotals.get(row.currency) ?? 0) + quote);
      if (!ready || !row.settlementChecked) continue;
    }
    pendingReconcileCount++;
    if (ready) unbilledPendingCount++;
  }

  const estimateCurrency: "CNY" | "USD" = estimate?.currency ?? defaultCurrency;
  let estimatedMicros: number | null = 0;
  let estimatedUnverifiedCount = 0;
  for (const clip of clips) {
    const hasReadyVideo = clip.progress?.videoState === "ready";
    const hasFrame = clip.progress?.keyframeApproved || clip.progress?.keyframeCandidateAvailable;
    if (!hasFrame) {
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

  const settled = toCurrencyAmounts(settledTotals);
  const quotedUnbilled = toCurrencyAmounts(quotedTotals);
  const costs: ComicEpisodeCostSummary = {
    settled,
    settledTakeCount,
    quotedUnbilled,
    unbilledReadyCount,
    remainingEstimate: {
      currency: estimateCurrency,
      amountMicros: estimatedMicros,
      unverifiedCount: estimatedUnverifiedCount,
    },
    pendingReconcileCount,
  };
  const spentMicros = settled.length === 1
    ? settled[0].amountMicros
    : (settledTotals.get(estimateCurrency) ?? 0);
  const displayCurrency = settled.length === 1 ? settled[0].currency : estimateCurrency;

  return {
    costs,
    estimatedMicros,
    estimatedUnverifiedCount,
    spentMicros,
    spentUnverifiedCount: pendingReconcileCount + unbilledReadyCount - unbilledPendingCount,
    currency: displayCurrency,
  };
}

function collectDraftMaterialRefs(draft: ComicDramaClipDraft): MaterialRefEntry[] {
  const entries: MaterialRefEntry[] = [];
  for (const { kind, ...ref } of draft.videoInputs?.references ?? []) entries.push({ role: kind, ...ref });
  if (draft.sceneRef) entries.push({ role: "scene", ...draft.sceneRef });
  for (const ref of draft.propRefs ?? []) entries.push({ role: "prop", ...ref });
  for (const ref of draft.sfxRefs ?? []) entries.push({ role: "sfx", ...ref });
  for (const shot of draft.shots) {
    for (const ref of shot.sfxRefs ?? []) entries.push({ role: "sfx", ...ref });
  }
  return entries;
}

const materialRefKey = (entry: Pick<MaterialRefEntry, "role" | "materialId" | "mediaId">) =>
  `${entry.role}:${entry.materialId}:${entry.mediaId}`;

function matchesMaterialKind(role: MaterialRefEntry["role"], kind: string) {
  if (role === "sfx") return kind === "sound";
  if (role === "audio") return ["sound", "music", "other"].includes(kind);
  if (role === "video") return kind === "other";
  if (role === "image" || role === "last_frame") return ["scene", "prop", "other"].includes(kind);
  return role === kind;
}

function isValidMaterialMime(role: MaterialRefEntry["role"], mime: string | null): boolean {
  if (!mime) return false;
  if (role === "sfx" || role === "audio") return mime === "audio/mpeg" || mime === "audio/wav";
  if (role === "video") return mime === "video/mp4" || mime === "video/quicktime";
  return mime.startsWith("image/");
}

async function inspectMaterialRefs(
  client: ComicQuery,
  owner: string,
  entries: readonly MaterialRefEntry[],
): Promise<Map<string, ComicInvalidMaterialRef>> {
  const invalid = new Map<string, ComicInvalidMaterialRef>();
  if (!entries.length) return invalid;
  const materialIds = [...new Set(entries.map(item => item.materialId))];
  const { rows } = await client.query<MaterialCheckRow>(
    `SELECT m.id AS "materialId", m.kind, (m.archived_at IS NOT NULL) AS archived,
       v.media_id AS "mediaId", f.mime, v.version,
       max(v.version) OVER (PARTITION BY m.id) AS "latestVersion"
     FROM lot_comic_drama.cd_materials m
     LEFT JOIN lot_comic_drama.cd_material_versions v ON (v.owner_id, v.material_id) = (m.owner_id, m.id)
     LEFT JOIN lot_comic_drama.cd_media f ON (f.owner_id, f.id) = (v.owner_id, v.media_id)
     WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[])
     ORDER BY v.version DESC NULLS LAST`,
    [owner, materialIds],
  );
  const byMaterial = new Map<string, MaterialCheckRow[]>();
  for (const row of rows) {
    const list = byMaterial.get(row.materialId) ?? [];
    list.push(row);
    byMaterial.set(row.materialId, list);
  }
  for (const entry of entries) {
    const key = materialRefKey(entry);
    if (invalid.has(key)) continue;
    const matRows = byMaterial.get(entry.materialId);
    if (!matRows?.length) {
      invalid.set(key, { ...entry, reason: "MISSING" });
      continue;
    }
    const head = matRows[0]!;
    if (head.archived) {
      invalid.set(key, { ...entry, reason: "ARCHIVED" });
      continue;
    }
    if (!matchesMaterialKind(entry.role, head.kind)) {
      invalid.set(key, { ...entry, reason: "WRONG_KIND" });
      continue;
    }
    const versionRow = matRows.find(row => row.mediaId === entry.mediaId);
    if (!versionRow || !isValidMaterialMime(entry.role, versionRow.mime)) {
      invalid.set(key, { ...entry, reason: "MISSING" });
      continue;
    }
    if (entry.role !== "scene" && entry.role !== "prop" && versionRow.latestVersion !== null && versionRow.version !== versionRow.latestVersion) {
      invalid.set(key, { ...entry, reason: "OUTDATED_VERSION" });
    }
  }
  return invalid;
}

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

  private async dramaRow(client: PoolClient, owner: string, dramaId: string, writable = false): Promise<ComicDrama> {
    const { rows } = await client.query<DramaRow>(
      `SELECT ${dramaFields} FROM lot_comic_drama.cd_dramas WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL
        ${writable ? "AND archived_at IS NULL FOR UPDATE" : ""}`,
      [owner, dramaId],
    );
    if (!rows[0]) throw new ComicDramaError("NOT_FOUND");
    return asDrama(rows[0]);
  }

  private async tryDramaRow(client: PoolClient, owner: string, dramaId: string): Promise<ComicDrama | null> {
    const { rows } = await client.query<DramaRow>(
      `SELECT ${dramaFields} FROM lot_comic_drama.cd_dramas WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [owner, dramaId],
    );
    return rows[0] ? asDrama(rows[0]) : null;
  }

  private async touchDrama(client: PoolClient, owner: string, dramaId: string) {
    await client.query(
      "UPDATE lot_comic_drama.cd_dramas SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2",
      [owner, dramaId],
    );
  }

  private async nextEpisodeNo(client: PoolClient, owner: string, dramaId: string): Promise<number> {
    const { rows } = await client.query<{ maxNo: number }>(
      `SELECT coalesce(max(episode_no),0)::int AS "maxNo" FROM lot_comic_drama.cd_series
       WHERE owner_id=$1 AND drama_id=$2 AND deleted_at IS NULL`,
      [owner, dramaId],
    );
    return Math.min((rows[0]?.maxNo ?? 0) + 1, 2_147_483_647);
  }

  private async dramaEpisodes(
    client: ComicQuery,
    owner: string,
    dramaId: string,
    includeArchived = false,
  ): Promise<ComicDramaEpisodeBrief[]> {
    type EpRow = {
      id: string;
      dramaId: string;
      episodeNo: number;
      title: string;
      logline: string;
      revision: number;
      archivedAt: Date | null;
      updatedAt: Date;
      clipCount: number;
      completedCount: number;
      generatingCount: number;
      hasRender: boolean;
      coverMediaId: string | null;
      hasTakes: boolean;
    };
    const { rows } = await client.query<EpRow>(
      `SELECT s.id, s.drama_id AS "dramaId", s.episode_no AS "episodeNo", s.title, s.logline, s.revision,
         s.archived_at AS "archivedAt", s.updated_at AS "updatedAt",
         (SELECT count(*)::int FROM lot_comic_drama.cd_clips WHERE series_id=s.id) AS "clipCount",
         EXISTS (SELECT 1 FROM lot_comic_drama.cd_renders r WHERE (r.owner_id,r.series_id)=(s.owner_id,s.id)
           AND r.media_id IS NOT NULL) AS "hasRender",
         (SELECT coalesce(c.keyframe_media_id, kt.media_id)
           FROM lot_comic_drama.cd_clips c
           LEFT JOIN lot_comic_drama.cd_takes kt ON kt.owner_id=s.owner_id AND kt.id=c.keyframe_take_id AND kt.status='ready'
           WHERE c.series_id=s.id AND (c.keyframe_media_id IS NOT NULL OR kt.media_id IS NOT NULL)
           ORDER BY (c.adopted_video_take_id IS NOT NULL) DESC, c.ordinal ASC LIMIT 1) AS "coverMediaId",
         (SELECT count(DISTINCT c.id)::int FROM lot_comic_drama.cd_clips c
           WHERE c.series_id=s.id AND EXISTS (
             SELECT 1 FROM lot_comic_drama.cd_takes t
             WHERE t.owner_id=s.owner_id AND t.target_id=c.id AND t.video_version IS NOT NULL AND t.status='ready'
           )) AS "completedCount",
         (SELECT count(DISTINCT t.target_id)::int FROM lot_comic_drama.cd_takes t
           JOIN lot_comic_drama.cd_generation_requests gr ON (gr.owner_id,gr.id)=(t.owner_id,t.request_id)
           WHERE gr.owner_id=s.owner_id AND gr.series_id=s.id AND t.status IN ('pending','running')) AS "generatingCount",
         EXISTS (SELECT 1 FROM lot_comic_drama.cd_generation_requests gr
           WHERE gr.owner_id=s.owner_id AND gr.series_id=s.id AND gr.confirmed_at IS NOT NULL) AS "hasTakes"
       FROM lot_comic_drama.cd_series s
       WHERE s.owner_id=$1 AND s.drama_id=$2 AND s.deleted_at IS NULL AND ($3::boolean OR s.archived_at IS NULL)
       ORDER BY s.episode_no ASC, s.created_at ASC, s.id ASC`,
      [owner, dramaId, includeArchived],
    );
    return rows.map(({ hasTakes, archivedAt, updatedAt, ...row }) => ({
      ...row,
      episodeNo: Number(row.episodeNo ?? 1),
      revision: Number(row.revision ?? 1),
      clipCount: Number(row.clipCount ?? 0),
      completedCount: Number(row.completedCount ?? 0),
      generatingCount: Number(row.generatingCount ?? 0),
      archivedAt: archivedAt?.toISOString() ?? null,
      updatedAt: updatedAt ? updatedAt.toISOString() : new Date().toISOString(),
      status: deriveEpisodeStatus(row.hasRender, row.completedCount, row.generatingCount, hasTakes),
    }));
  }

  private fallbackDrama(series: ComicDramaSeries): ComicDrama {
    return {
      id: series.dramaId,
      title: series.seriesGroup ?? series.title,
      synopsis: series.logline,
      outline: "",
      scriptContent: "",
      styleKey: series.styleKey,
      aspectRatio: series.aspectRatio,
      videoModel: series.videoModel,
      revision: 1,
      archivedAt: series.archivedAt,
    };
  }

  private fallbackEpisodeBrief(
    series: ComicDramaSeries,
    clipCount: number,
    completedCount: number,
    generatingCount: number,
  ): ComicDramaEpisodeBrief {
    return {
      id: series.id,
      dramaId: series.dramaId,
      episodeNo: series.episodeNo ?? 1,
      title: series.title,
      logline: series.logline,
      revision: series.revision,
      archivedAt: series.archivedAt,
      updatedAt: new Date().toISOString(),
      clipCount,
      completedCount,
      generatingCount,
      hasRender: false,
      coverMediaId: null,
      status: deriveEpisodeStatus(false, completedCount, generatingCount, false),
    };
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
        EXISTS (SELECT 1 FROM lot_comic_drama.cd_takes t
          JOIN lot_comic_drama.cd_media m ON (m.owner_id,m.id)=(t.owner_id,t.media_id)
          WHERE t.owner_id=$1 AND t.target_id=c.id AND t.video_version IS NULL AND t.status='ready'
            AND (t.input->>'clipRevision')::int=c.revision) AS "keyframeCandidateAvailable",
        (SELECT t.status FROM lot_comic_drama.cd_takes t
          WHERE t.owner_id=$1 AND t.target_id=c.id AND t.video_version IS NULL AND (t.input->>'clipRevision')::int=c.revision
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
        JOIN tasks job ON job.id=r.task_id AND job.user_id=r.owner_id::text
        WHERE r.owner_id=$1 AND r.series_id=$2 AND t.status IN ('pending', 'running') AND job.status IN ('pending','running')`,
      [owner, seriesId],
    );
    const asState = (value: string | null): ComicClipProgress["keyframeState"] => {
      if (value === "pending" || value === "running" || value === "ready" || value === "failed" ||
        value === "recoverable" || value === "unknown") return value;
      return "none";
    };
    const allMaterialRefs = clips.flatMap(clip => collectDraftMaterialRefs(clip.draft));
    const invalidMaterialMap = await inspectMaterialRefs(client, owner, allMaterialRefs);
    const enriched = clips.map(clip => {
      const meta = byId.get(clip.id);
      if (!meta) return clip;
      if (meta.readyVideoCount > 0) completedCount += 1;
      const takeApproved = !!meta.keyframeTakeId && meta.keyframeTakeState === "ready" && meta.keyframeTakeRev === clip.revision;
      const manualApproved = !meta.keyframeTakeId && !!meta.keyframeMediaId;
      const keyframeApproved = takeApproved || manualApproved;
      const keyframeMediaId = takeApproved ? meta.keyframeTakeMediaId : manualApproved ? meta.keyframeMediaId : meta.keyframeTakeMediaId;
      const keyframeStale = !!meta.keyframeTakeId && meta.keyframeTakeState === "ready" && meta.keyframeTakeRev !== clip.revision;
      const seenInvalid = new Set<string>();
      const invalidMaterialRefs: ComicInvalidMaterialRef[] = [];
      for (const entry of collectDraftMaterialRefs(clip.draft)) {
        const key = materialRefKey(entry);
        if (seenInvalid.has(key)) continue;
        const issue = invalidMaterialMap.get(key);
        if (issue) {
          seenInvalid.add(key);
          invalidMaterialRefs.push(issue);
        }
      }
      const progress: ComicClipProgress = {
        keyframeState: keyframeApproved ? "ready" : asState(meta.latestImageState),
        keyframeMediaId: keyframeMediaId ?? null,
        keyframeApproved,
        keyframeCandidateAvailable: meta.keyframeCandidateAvailable,
        keyframeStale,
        videoState: meta.adoptedVideoTakeId ? "ready" : asState(meta.latestVideoState),
        latestVideoState: asState(meta.latestVideoState),
        videoTakeCount: meta.videoTakeCount,
        adoptedVideoTakeId: meta.adoptedVideoTakeId,
        adoptedVideoVersion: meta.adoptedVersion,
        adoptedVideoMediaId: meta.adoptedMediaId,
        adoptedStale: !!meta.adoptedVideoTakeId && meta.adoptedClipRev !== null && meta.adoptedClipRev !== clip.revision,
        castSnapshotStale: isCastSnapshotStale(meta.adoptedRefs, cast),
        ...(invalidMaterialRefs.length ? { invalidMaterialRefs } : {}),
      };
      return { ...clip, progress };
    });
    return { clips: enriched, completedCount, generatingCount: genRow?.generating ?? 0 };
  }

  private async buildSummary(
    client: PoolClient, owner: string, series: ComicDramaSeries, clips: ComicDramaClip[], completedCount: number, generatingCount: number,
    dramaTitle?: string, episodeCount?: number,
  ): Promise<ComicDramaEpisodeSummary> {
    const { rows: spendRows } = await client.query<EpisodeSpendRow>(
      `SELECT (r.frozen->'price'->>'amountMicros')::double precision AS "amountMicros",
         (r.frozen->'price'->'clipAmounts'->>t.target_id::text)::double precision AS "quotedTotalMicros",
         r.frozen->'price'->>'unit' AS unit,
         (t.input->>'durationMs')::int AS "durationMs",
          CASE WHEN t.submit_state IS NULL AND t.status IN ('pending','running','recoverable') AND ${comicBatchCreditPaused} THEN 'pending'
            WHEN t.status IN ('pending','running','recoverable') AND coalesce(job.status,'failed') NOT IN ('pending','running') THEN
           CASE WHEN (CASE WHEN t.video_version IS NOT NULL
             THEN coalesce(t.submit_state,'unsubmitted') IN ('unsubmitted','accepted','output')
             ELSE (receipt.state IN ('submitted','completed') OR receipt.state IS NULL) END)
             THEN 'recoverable' WHEN receipt.state='failed' THEN 'failed' ELSE 'unknown' END
           ELSE t.status END AS status,
         t.submit_state AS "submitState",
         coalesce(t.error, receipt.error) AS error,
         t.gateway_http_status AS "gatewayHttpStatus",
         r.frozen->'price'->>'currency' AS currency,
         t.settled_amount_micros::text AS "settledAmountMicros",
         t.settled_currency AS "settledCurrency", t.settlement_checked_at IS NOT NULL AS "settlementChecked"
       FROM lot_comic_drama.cd_takes t
       JOIN lot_comic_drama.cd_generation_requests r ON (r.owner_id, r.id) = (t.owner_id, t.request_id)
       LEFT JOIN tasks job ON job.id = r.task_id AND job.user_id = t.owner_id::text
       LEFT JOIN image_call_receipts receipt ON receipt.task_id = job.id AND receipt.user_id = t.owner_id::text AND receipt.slot = t.slot
       WHERE r.owner_id=$1 AND r.series_id=$2 AND r.confirmed_at IS NOT NULL`,
      [owner, series.id],
    );
    const estimate = this.costEstimator ? await this.costEstimator(owner, series.videoModel, client).catch(() => null) : null;
    const costBreakdown = summarizeEpisodeCosts(spendRows, clips, estimate, comicQuoteCurrency());
    return {
      dramaId: series.dramaId,
      dramaTitle: dramaTitle ?? series.seriesGroup ?? series.title,
      episodeNo: series.episodeNo ?? 1,
      episodeCount: episodeCount ?? 1,
      seriesId: series.id,
      title: series.title,
      archived: !!series.archivedAt,
      clipCount: clips.length,
      completedCount,
      generatingCount,
      totalDurationMs: clips.reduce((sum, clip) => sum + clip.draft.durationMs, 0),
      ...costBreakdown,
    };
  }

  private async buildDetail(
    client: PoolClient,
    owner: string,
    series: ComicDramaSeries,
    rawClips: ComicDramaClip[],
    script: ComicDramaDetail["script"],
    cast: ComicSeriesCast[],
    completedCount: number,
    generatingCount: number,
  ): Promise<ComicDramaDetail> {
    const drama = (await this.tryDramaRow(client, owner, series.dramaId)) ?? this.fallbackDrama(series);
    const queriedEpisodes = await this.dramaEpisodes(client, owner, series.dramaId, !!series.archivedAt);
    const episodes = queriedEpisodes.length
      ? queriedEpisodes
      : [this.fallbackEpisodeBrief(series, rawClips.length, completedCount, generatingCount)];
    const { rows: [castCountRow] } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM lot_comic_drama.cd_drama_cast WHERE owner_id=$1 AND drama_id=$2",
      [owner, series.dramaId],
    );
    const dramaCastCount = Number(castCountRow?.n ?? 0);
    const clips = rawClips.map(clip => ({ ...clip, dramaId: series.dramaId, episodeId: clip.episodeId ?? series.id }));
    const hierarchy = buildComicDramaHierarchy(drama, series, clips, episodes.length);
    const summary = await this.buildSummary(client, owner, series, clips, completedCount, generatingCount, drama.title, episodes.length);
    return { drama, episodes, hierarchy, series, clips, script, cast, dramaCastCount, summary };
  }

  async recordTakeSettlement(
    owner: string,
    takeId: string,
    settlement: { amountMicros: number; currency: "CNY" | "USD"; source?: string },
    receipt?: { request: string | null; task: string | null },
  ): Promise<boolean> {
    if (!Number.isSafeInteger(settlement.amountMicros) || settlement.amountMicros < 0) {
      throw new ComicDramaError("INVALID_ORDER");
    }
    try {
      const { rowCount } = await this.pool.query(
        `UPDATE lot_comic_drama.cd_takes t
         SET settled_amount_micros=$3, settled_currency=$4, settled_at=now(), settled_source=$5
         WHERE t.owner_id=$1 AND t.id=$2 AND t.settled_amount_micros IS NULL
           AND (NOT $6::boolean OR t.gateway_request_id=$7 OR t.vendor_id=$8 OR EXISTS (
             SELECT 1 FROM lot_comic_drama.cd_generation_requests r
             JOIN image_call_receipts i ON i.user_id=r.owner_id::text AND i.task_id=r.task_id AND i.slot=t.slot
             WHERE (r.owner_id,r.id)=(t.owner_id,t.request_id) AND i.gateway_request_id=$7
           ))`,
        [owner, takeId, settlement.amountMicros, settlement.currency, settlement.source ?? "gateway",
          !!receipt, receipt?.request ?? null, receipt?.task ?? null],
      );
      return !!rowCount;
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "cd_takes_gateway_settlement_unique") return false;
      throw error;
    }
  }

  private async content(client: PoolClient, id: string, seriesRevision: number): Promise<ComicDramaContent> {
    const clips = await client.query(`SELECT ${clipFields} FROM lot_comic_drama.cd_clips WHERE series_id=$1 ORDER BY ordinal`, [id]);
    const script = await client.query("SELECT version, content FROM lot_comic_drama.cd_scripts WHERE series_id=$1 ORDER BY version DESC LIMIT 1", [id]);
    return { seriesRevision, clips: clips.rows.map(row => comicDramaClipSchema.parse(row)), script: script.rows[0] ?? null,
      cast: await readSeriesCast(client, id) };
  }

  async listDramas(owner: string, { query, archived, status, cursor }: ComicDramaHierarchyListQuery): Promise<ComicDramaTreeListing> {
    const [at, id] = cursor?.split(",") ?? [];
    if (cursor && (cursor.split(",").length !== 2 || !Number.isFinite(Date.parse(at)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicDramaError("INVALID_CURSOR");
    }
    type DramaListRow = DramaRow & {
      updatedAt: Date;
      episodeCount: number;
      exportedEpisodeCount: number;
      hasInProgressEpisode: boolean;
      castCount?: number;
    };
    const { rows } = await this.pool.query<DramaListRow>(
      `WITH ep_stats AS (
         SELECT s.id, s.owner_id, s.drama_id,
           EXISTS (SELECT 1 FROM lot_comic_drama.cd_renders r
             WHERE (r.owner_id,r.series_id)=(s.owner_id,s.id) AND r.media_id IS NOT NULL) AS has_render,
           EXISTS (SELECT 1 FROM lot_comic_drama.cd_clips c JOIN lot_comic_drama.cd_takes t
             ON t.owner_id=s.owner_id AND t.target_id=c.id AND t.video_version IS NOT NULL AND t.status='ready'
             WHERE c.series_id=s.id)
           OR EXISTS (SELECT 1 FROM lot_comic_drama.cd_generation_requests gr
             WHERE gr.owner_id=s.owner_id AND gr.series_id=s.id AND gr.confirmed_at IS NOT NULL) AS in_progress
         FROM lot_comic_drama.cd_series s
         WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND ($2::boolean OR s.archived_at IS NULL)
       ),
       base AS (
         SELECT ${dramaFields},
           (SELECT count(*)::int FROM ep_stats es WHERE es.drama_id=d.id) AS "episodeCount",
           (SELECT count(*)::int FROM ep_stats es WHERE es.drama_id=d.id AND es.has_render) AS "exportedEpisodeCount",
           EXISTS (SELECT 1 FROM ep_stats es WHERE es.drama_id=d.id AND NOT es.has_render AND es.in_progress) AS "hasInProgressEpisode",
           (SELECT count(*)::int FROM lot_comic_drama.cd_drama_cast dc WHERE dc.owner_id=d.owner_id AND dc.drama_id=d.id) AS "castCount"
         FROM lot_comic_drama.cd_dramas d
         WHERE d.owner_id=$1 AND d.deleted_at IS NULL AND (d.archived_at IS NOT NULL)=$2
           AND ($3='' OR strpos(lower(d.title),lower($3))>0 OR strpos(lower(d.synopsis),lower($3))>0 OR EXISTS (
             SELECT 1 FROM lot_comic_drama.cd_series s
             WHERE s.owner_id=d.owner_id AND s.drama_id=d.id AND s.deleted_at IS NULL AND strpos(lower(s.title),lower($3))>0
           ))
           AND ($4::timestamptz IS NULL OR (d.updated_at,d.id)<($4::timestamptz,$5::uuid))
       )
       SELECT * FROM base
       WHERE ($6::text IS NULL OR (CASE
         WHEN "episodeCount">0 AND "exportedEpisodeCount"="episodeCount" THEN 'exported'
         WHEN "exportedEpisodeCount">0 OR "hasInProgressEpisode" THEN 'in_progress'
         ELSE 'draft' END)=$6)
       ORDER BY "updatedAt" DESC, id DESC LIMIT 25`,
      [owner, archived === "true", query ?? "", at ?? null, id ?? null, status ?? null],
    );
    const pageRows = rows.slice(0, 24);
    const dramaIds = pageRows.map(row => row.id);
    const episodesByDrama = new Map<string, ComicDramaEpisodeBrief[]>();
    if (dramaIds.length) {
      type EpRow = {
        id: string; dramaId: string; episodeNo: number; title: string; logline: string; revision: number;
        archivedAt: Date | null; updatedAt: Date; clipCount: number; completedCount: number; generatingCount: number;
        hasRender: boolean; coverMediaId: string | null; hasTakes: boolean;
      };
      const { rows: epRows } = await this.pool.query<EpRow>(
        `SELECT s.id, s.drama_id AS "dramaId", s.episode_no AS "episodeNo", s.title, s.logline, s.revision,
           s.archived_at AS "archivedAt", s.updated_at AS "updatedAt",
           (SELECT count(*)::int FROM lot_comic_drama.cd_clips WHERE series_id=s.id) AS "clipCount",
           EXISTS (SELECT 1 FROM lot_comic_drama.cd_renders r WHERE (r.owner_id,r.series_id)=(s.owner_id,s.id)
             AND r.media_id IS NOT NULL) AS "hasRender",
           (SELECT coalesce(c.keyframe_media_id, kt.media_id)
             FROM lot_comic_drama.cd_clips c
             LEFT JOIN lot_comic_drama.cd_takes kt ON kt.owner_id=s.owner_id AND kt.id=c.keyframe_take_id AND kt.status='ready'
             WHERE c.series_id=s.id AND (c.keyframe_media_id IS NOT NULL OR kt.media_id IS NOT NULL)
             ORDER BY (c.adopted_video_take_id IS NOT NULL) DESC, c.ordinal ASC LIMIT 1) AS "coverMediaId",
           (SELECT count(DISTINCT c.id)::int FROM lot_comic_drama.cd_clips c
             WHERE c.series_id=s.id AND EXISTS (
               SELECT 1 FROM lot_comic_drama.cd_takes t
               WHERE t.owner_id=s.owner_id AND t.target_id=c.id AND t.video_version IS NOT NULL AND t.status='ready'
             )) AS "completedCount",
           (SELECT count(DISTINCT t.target_id)::int FROM lot_comic_drama.cd_takes t
             JOIN lot_comic_drama.cd_generation_requests gr ON (gr.owner_id,gr.id)=(t.owner_id,t.request_id)
             WHERE gr.owner_id=s.owner_id AND gr.series_id=s.id AND t.status IN ('pending','running')) AS "generatingCount",
           EXISTS (SELECT 1 FROM lot_comic_drama.cd_generation_requests gr
             WHERE gr.owner_id=s.owner_id AND gr.series_id=s.id AND gr.confirmed_at IS NOT NULL) AS "hasTakes"
         FROM lot_comic_drama.cd_series s
         WHERE s.owner_id=$1 AND s.drama_id=ANY($2::uuid[]) AND s.deleted_at IS NULL AND ($3::boolean OR s.archived_at IS NULL)
         ORDER BY s.episode_no ASC, s.created_at ASC, s.id ASC`,
        [owner, dramaIds, archived === "true"],
      );
      for (const { hasTakes, archivedAt, updatedAt, ...ep } of epRows) {
        const list = episodesByDrama.get(ep.dramaId) ?? [];
        list.push({
          ...ep,
          episodeNo: Number(ep.episodeNo ?? 1),
          revision: Number(ep.revision ?? 1),
          clipCount: Number(ep.clipCount ?? 0),
          completedCount: Number(ep.completedCount ?? 0),
          generatingCount: Number(ep.generatingCount ?? 0),
          archivedAt: archivedAt?.toISOString() ?? null,
          updatedAt: updatedAt ? updatedAt.toISOString() : new Date().toISOString(),
          status: deriveEpisodeStatus(ep.hasRender, ep.completedCount, ep.generatingCount, hasTakes),
        });
        episodesByDrama.set(ep.dramaId, list);
      }
    }
    const dramas: ComicDramaTreeEntry[] = pageRows.map(
      ({ episodeCount, exportedEpisodeCount, hasInProgressEpisode: _inProg, castCount, ...row }) => {
        const drama = asDrama(row);
        const episodes = episodesByDrama.get(drama.id) ?? [];
        const clipCount = episodes.reduce((sum, ep) => sum + ep.clipCount, 0);
        const completedClipCount = episodes.reduce((sum, ep) => sum + ep.completedCount, 0);
        const generatingClipCount = episodes.reduce((sum, ep) => sum + ep.generatingCount, 0);
        const coverMediaId = episodes.find(ep => ep.coverMediaId)?.coverMediaId ?? null;
        const derived = deriveDramaStatus(episodeCount, exportedEpisodeCount, episodes);
        return {
          ...drama,
          updatedAt: drama.updatedAt ?? row.updatedAt.toISOString(),
          episodeCount,
          clipCount,
          completedClipCount,
          generatingClipCount,
          exportedEpisodeCount,
          coverMediaId,
          status: derived,
          episodes,
          castCount: Number(castCount ?? 0),
          hasOutline: drama.outline.trim().length > 0,
          hasScript: drama.scriptContent.trim().length > 0,
        };
      },
    );
    const last = dramas.at(-1);
    return { dramas, nextCursor: rows.length > 24 && last ? `${last.updatedAt},${last.id}` : null };
  }

  async listDramaOptions(owner: string): Promise<ComicDramaOption[]> {
    const { rows } = await this.pool.query<ComicDramaOption>(
      `SELECT id, title, (archived_at IS NOT NULL) AS archived
       FROM lot_comic_drama.cd_dramas
       WHERE owner_id=$1 AND deleted_at IS NULL
       ORDER BY (archived_at IS NOT NULL) ASC, updated_at DESC, id DESC
       LIMIT 200`,
      [owner],
    );
    return rows;
  }

  getDrama(owner: string, dramaId: string): Promise<ComicDramaView> {
    return this.transaction(async client => {
      const drama = await this.dramaRow(client, owner, dramaId);
      const episodes = await this.dramaEpisodes(client, owner, dramaId, !!drama.archivedAt);
      const cast = await readDramaCast(client, dramaId);
      return { drama, episodes, cast };
    }, true);
  }

  openDrama(owner: string, dramaId: string): Promise<ComicDramaView> {
    return this.transaction(async client => {
      const drama = await this.dramaRow(client, owner, dramaId, true);
      await this.setCurrentDrama(client, owner, drama.id);
      const episodes = await this.dramaEpisodes(client, owner, dramaId, false);
      const cast = await readDramaCast(client, dramaId);
      return { drama, episodes, cast };
    });
  }

  async currentDrama(owner: string): Promise<ComicDramaCurrentState> {
    return this.transaction(async client => {
      const { rows } = await client.query<{ seriesId: string | null; dramaId: string | null }>(
        `SELECT current_series_id AS "seriesId", current_drama_id AS "dramaId"
         FROM lot_comic_drama.cd_user_state WHERE owner_id=$1`,
        [owner],
      );
      let seriesId = rows[0]?.seriesId ?? null;
      let dramaId = rows[0]?.dramaId ?? null;
      if (seriesId) {
        const { rows: [ep] } = await client.query<{ dramaId: string }>(
          `SELECT drama_id AS "dramaId" FROM lot_comic_drama.cd_series
           WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND archived_at IS NULL`,
          [owner, seriesId],
        );
        if (ep) dramaId = ep.dramaId;
        else seriesId = null;
      }
      if (!dramaId) return { dramaId: null, seriesId: null, drama: null, episodeCount: 0, castCount: 0 };
      const drama = await this.tryDramaRow(client, owner, dramaId);
      if (!drama || drama.archivedAt) {
        return { dramaId: null, seriesId: null, drama: null, episodeCount: 0, castCount: 0 };
      }
      const { rows: [stats] } = await client.query<{ episodeCount: number; castCount: number }>(
        `SELECT
           (SELECT count(*)::int FROM lot_comic_drama.cd_series s
             WHERE s.owner_id=$1 AND s.drama_id=$2 AND s.deleted_at IS NULL AND s.archived_at IS NULL) AS "episodeCount",
           (SELECT count(*)::int FROM lot_comic_drama.cd_drama_cast dc
             WHERE dc.owner_id=$1 AND dc.drama_id=$2) AS "castCount"`,
        [owner, drama.id],
      );
      return {
        dramaId: drama.id,
        seriesId,
        drama,
        episodeCount: Number(stats?.episodeCount ?? 0),
        castCount: Number(stats?.castCount ?? 0),
      };
    }, true);
  }

  createDrama(owner: string, input: ComicDramaCreateInput): Promise<{ drama: ComicDrama; detail: ComicDramaDetail | null }> {
    return this.transaction(async client => {
      await requireComicChoice(client, owner, "style", input.styleKey);
      const { rows: [dRow] } = await client.query<DramaRow>(
        `INSERT INTO lot_comic_drama.cd_dramas(owner_id,title,synopsis,outline,script_content,style_key,aspect_ratio,video_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${dramaFields}`,
        [owner, input.title, input.synopsis ?? "", input.outline ?? "", input.scriptContent ?? "",
          input.styleKey, input.aspectRatio, input.videoModel ?? null],
      );
      const drama = asDrama(dRow);
      if (input.createFirstEpisode === false) {
        await this.setCurrentDrama(client, owner, drama.id);
        return { drama, detail: null };
      }
      const epTitle = input.firstEpisodeTitle?.trim() || input.title;
      const epLogline = input.firstEpisodeLogline ?? "";
      const series = await this.insert(client, owner, {
        dramaId: drama.id,
        title: epTitle,
        logline: epLogline,
        seriesGroup: drama.title,
        episodeNo: 1,
        styleKey: drama.styleKey,
        aspectRatio: drama.aspectRatio,
        videoModel: drama.videoModel,
      });
      await this.setCurrent(client, owner, series.id, drama.id);
      const detail = await this.buildDetail(client, owner, series, [], null, [], 0, 0);
      return { drama, detail };
    });
  }

  updateDrama(owner: string, dramaId: string, input: ComicDramaUpdateInput): Promise<ComicDrama> {
    return this.transaction(async client => {
      const current = await this.dramaRow(client, owner, dramaId, true);
      requireRevision(current.revision, input.expectedRevision);
      if (current.styleKey !== input.styleKey) await requireComicChoice(client, owner, "style", input.styleKey);
      const outline = input.outline ?? current.outline;
      const scriptContent = input.scriptContent ?? current.scriptContent;
      const { rows: [dRow] } = await client.query<DramaRow>(
        `UPDATE lot_comic_drama.cd_dramas
         SET title=$2,synopsis=$3,outline=$4,script_content=$5,style_key=$6,aspect_ratio=$7,video_model=$8,
           revision=revision+1,updated_at=clock_timestamp()
         WHERE id=$1 RETURNING ${dramaFields}`,
        [dramaId, input.title, input.synopsis, outline, scriptContent, input.styleKey, input.aspectRatio, input.videoModel],
      );
      if (current.title !== input.title) {
        await client.query(
          `UPDATE lot_comic_drama.cd_series SET series_group=$3, updated_at=clock_timestamp()
           WHERE owner_id=$1 AND drama_id=$2 AND deleted_at IS NULL`,
          [owner, dramaId, input.title],
        );
      }
      return asDrama(dRow);
    });
  }

  saveDramaOutline(owner: string, dramaId: string, expectedRevision: number, outline: string): Promise<ComicDrama> {
    return this.transaction(async client => {
      const current = await this.dramaRow(client, owner, dramaId, true);
      requireRevision(current.revision, expectedRevision);
      const { rows: [dRow] } = await client.query<DramaRow>(
        `UPDATE lot_comic_drama.cd_dramas
         SET outline=$2, revision=revision+1, updated_at=clock_timestamp()
         WHERE id=$1 RETURNING ${dramaFields}`,
        [dramaId, outline],
      );
      return asDrama(dRow);
    });
  }

  saveDramaScript(owner: string, dramaId: string, expectedRevision: number, content: string): Promise<ComicDrama> {
    return this.transaction(async client => {
      const current = await this.dramaRow(client, owner, dramaId, true);
      requireRevision(current.revision, expectedRevision);
      const { rows: [dRow] } = await client.query<DramaRow>(
        `UPDATE lot_comic_drama.cd_dramas
         SET script_content=$2, revision=revision+1, updated_at=clock_timestamp()
         WHERE id=$1 RETURNING ${dramaFields}`,
        [dramaId, content],
      );
      return asDrama(dRow);
    });
  }

  readDramaCast(owner: string, dramaId: string): Promise<ComicDramaCastContent> {
    return this.transaction(async client => {
      const drama = await this.dramaRow(client, owner, dramaId);
      return { cast: await readDramaCast(client, dramaId), dramaRevision: drama.revision };
    }, true);
  }

  changeDramaCast(
    owner: string,
    dramaId: string,
    expectedRevision: number,
    change: ComicCastChange,
  ): Promise<ComicDramaCastContent> {
    return this.transaction(async client => {
      const drama = await this.dramaRow(client, owner, dramaId, true);
      requireRevision(drama.revision, expectedRevision);
      await editDramaCast(client, owner, dramaId, change);
      const { rows: [bumped] } = await client.query<{ revision: number }>(
        `UPDATE lot_comic_drama.cd_dramas SET revision=revision+1, updated_at=clock_timestamp()
         WHERE id=$1 RETURNING revision`,
        [dramaId],
      );
      return { cast: await readDramaCast(client, dramaId), dramaRevision: bumped.revision };
    });
  }

  syncEpisodeCastFromDrama(owner: string, seriesId: string, expectedRevision: number): Promise<ComicDramaContent> {
    return this.editContent(owner, seriesId, expectedRevision, async client => {
      const series = await this.series(client, owner, seriesId);
      await syncDramaCastToSeries(client, owner, series.dramaId, seriesId);
    });
  }

  createEpisode(owner: string, dramaId: string, input: ComicDramaEpisodeCreateInput): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      const drama = await this.dramaRow(client, owner, dramaId, true);
      const inherit = input.inheritCastAndStyle !== false;
      let parentId: string | null = null;
      let styleKey = input.styleKey ?? drama.styleKey;
      let aspectRatio = input.aspectRatio ?? drama.aspectRatio;
      let videoModel = input.videoModel !== undefined ? input.videoModel : drama.videoModel;
      if (input.sourceSeriesId) {
        const source = await this.series(client, owner, input.sourceSeriesId);
        parentId = source.id;
        if (inherit) {
          styleKey = input.styleKey ?? source.styleKey;
          aspectRatio = input.aspectRatio ?? source.aspectRatio;
          if (input.videoModel === undefined) videoModel = source.videoModel;
        }
      }
      await requireComicChoice(client, owner, "style", styleKey);
      const episodeNo = input.episodeNo ?? await this.nextEpisodeNo(client, owner, drama.id);
      const series = await this.insert(client, owner, {
        dramaId: drama.id,
        title: input.title,
        logline: input.logline ?? "",
        seriesGroup: drama.title,
        episodeNo,
        styleKey,
        aspectRatio,
        videoModel,
      }, parentId);
      if (parentId && inherit) {
        await client.query(
          `INSERT INTO lot_comic_drama.cd_series_cast(owner_id,series_id,character_id,outfit_id,snapshot)
           SELECT owner_id,$1,character_id,outfit_id,snapshot FROM lot_comic_drama.cd_series_cast WHERE owner_id=$2 AND series_id=$3`,
          [series.id, owner, parentId],
        );
      } else if (inherit) {
        await syncDramaCastToSeries(client, owner, drama.id, series.id);
      }
      let initialScript: ComicDramaDetail["script"] = null;
      if (input.initialScript?.trim()) {
        await client.query(
          `INSERT INTO lot_comic_drama.cd_scripts(series_id,version,content,source) VALUES ($1,1,$2,'user')`,
          [series.id, input.initialScript],
        );
        initialScript = { version: 1, content: input.initialScript };
      }
      await this.touchDrama(client, owner, drama.id);
      await this.setCurrent(client, owner, series.id, drama.id);
      const cast = inherit ? await readSeriesCast(client, series.id) : [];
      return this.buildDetail(client, owner, series, [], initialScript, cast, 0, 0);
    });
  }

  private async hideDrama(owner: string, dramaId: string, expected: number, column: "archived_at" | "deleted_at") {
    await this.transaction(async client => {
      const result = await client.query(
        "SELECT revision FROM lot_comic_drama.cd_dramas WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        [owner, dramaId],
      );
      if (!result.rows[0]) throw new ComicDramaError("NOT_FOUND");
      requireRevision(result.rows[0].revision, expected);
      await client.query(
        `UPDATE lot_comic_drama.cd_dramas SET ${column}=now(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
        [dramaId],
      );
      await client.query(
        `UPDATE lot_comic_drama.cd_series SET ${column}=coalesce(${column},now()),revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_id=$1 AND drama_id=$2 AND deleted_at IS NULL`,
        [owner, dramaId],
      );
      await client.query(
        `UPDATE lot_comic_drama.cd_user_state
         SET current_series_id = CASE
               WHEN current_series_id IN (SELECT id FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND drama_id=$2) THEN NULL
               ELSE current_series_id
             END,
             current_drama_id = CASE WHEN current_drama_id=$2 THEN NULL ELSE current_drama_id END
         WHERE owner_id=$1`,
        [owner, dramaId],
      );
    });
  }

  archiveDrama(owner: string, dramaId: string, expectedRevision: number) { return this.hideDrama(owner, dramaId, expectedRevision, "archived_at"); }
  removeDrama(owner: string, dramaId: string, expectedRevision: number) { return this.hideDrama(owner, dramaId, expectedRevision, "deleted_at"); }

  async list(owner: string, { query, archived, status, dramaId, seriesGroup, cursor }: ComicDramaListQuery): Promise<ComicDramaListing> {
    const [at, id] = cursor?.split(",") ?? [];
    if (cursor && (cursor.split(",").length !== 2 || !Number.isFinite(Date.parse(at)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicDramaError("INVALID_CURSOR");
    }
    type ListRow = SeriesRow & {
      dramaTitle: string | null;
      updatedAt: Date; clipCount: number; hasRender: boolean; coverMediaId: string | null;
      completedCount: number; generatingCount: number; hasTakes: boolean;
    };
    const { rows } = await this.pool.query<ListRow>(
      `WITH base AS (
        SELECT ${seriesFields.replace(/\b(id|drama_id|parent_id|title|logline|series_group|episode_no|style_key|aspect_ratio|video_model|revision|archived_at)\b/g, "series.$1")},
          d.title AS "dramaTitle", series.updated_at AS "updatedAt",
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
        FROM lot_comic_drama.cd_series AS series
        LEFT JOIN lot_comic_drama.cd_dramas d ON (d.owner_id, d.id)=(series.owner_id, series.drama_id)
        WHERE series.owner_id=$1 AND series.deleted_at IS NULL AND (series.archived_at IS NOT NULL)=$2
        AND (strpos(lower(series.title),lower($3))>0 OR strpos(lower(coalesce(series.series_group,'')),lower($3))>0
          OR strpos(lower(coalesce(d.title,'')),lower($3))>0 OR $3='')
        AND ($6::text IS NULL OR series.series_group=$6 OR d.title=$6)
        AND ($8::uuid IS NULL OR series.drama_id=$8)
        AND ($4::timestamptz IS NULL OR (series.updated_at,series.id)<($4::timestamptz,$5::uuid))
      )
      SELECT * FROM base
      WHERE ($7::text IS NULL OR (CASE WHEN "hasRender" THEN 'exported' WHEN "completedCount">0 OR "generatingCount">0 OR "hasTakes" THEN 'in_progress' ELSE 'draft' END)=$7)
      ORDER BY "updatedAt" DESC, id DESC LIMIT 25`,
      [owner, archived === "true", query ?? "", at ?? null, id ?? null, seriesGroup ?? null, status ?? null, dramaId ?? null],
    );
    const entries = rows.slice(0, 24).map(
      ({ dramaTitle, updatedAt, clipCount, hasRender, coverMediaId, completedCount, generatingCount, hasTakes, ...row }) => {
      const derivedStatus = deriveEpisodeStatus(hasRender, completedCount, generatingCount, hasTakes);
      return {
        ...asSeries(row),
        ...(dramaTitle ? { dramaTitle } : {}),
        updatedAt: updatedAt ? updatedAt.toISOString() : new Date().toISOString(),
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
      return this.buildDetail(client, owner, series, clips, script, cast, completedCount, generatingCount);
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

  private async setCurrent(client: PoolClient, owner: string, id: string, dramaId?: string) {
    await client.query(
      `INSERT INTO lot_comic_drama.cd_user_state(owner_id,current_series_id,current_drama_id)
       VALUES ($1,$2,coalesce($3::uuid,(SELECT drama_id FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND id=$2)))
       ON CONFLICT (owner_id) DO UPDATE
         SET current_series_id=excluded.current_series_id,
             current_drama_id=coalesce(excluded.current_drama_id, lot_comic_drama.cd_user_state.current_drama_id)`,
      [owner, id, dramaId ?? null],
    );
  }

  private async setCurrentDrama(client: PoolClient, owner: string, dramaId: string) {
    await client.query(
      `INSERT INTO lot_comic_drama.cd_user_state(owner_id,current_series_id,current_drama_id)
       VALUES ($1,NULL,$2)
       ON CONFLICT (owner_id) DO UPDATE
         SET current_series_id=NULL, current_drama_id=excluded.current_drama_id`,
      [owner, dramaId],
    );
  }

  open(owner: string, id: string): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id, true);
      await this.setCurrent(client, owner, id, series.dramaId);
      const { clips: rawClips, script, cast } = await this.content(client, id, series.revision);
      const { clips, completedCount, generatingCount } = await this.attachProgress(client, owner, id, rawClips, cast);
      return this.buildDetail(client, owner, series, clips, script, cast, completedCount, generatingCount);
    });
  }

  private async insert(
    client: PoolClient,
    owner: string,
    fields: ComicDramaSeriesInput & { dramaId: string; episodeNo: number },
    parentId: string | null = null,
  ) {
    const { dramaId, title, logline = "", seriesGroup = null, episodeNo, styleKey, aspectRatio, videoModel } = fields;
    const { rows } = await client.query<SeriesRow>(`INSERT INTO lot_comic_drama.cd_series
      (owner_id,drama_id,parent_id,title,logline,series_group,episode_no,style_key,aspect_ratio,video_model)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${seriesFields}`,
      [owner, dramaId, parentId, title, logline, seriesGroup, episodeNo, styleKey, aspectRatio, videoModel]);
    return asSeries(rows[0]);
  }

  private async resolveOrCreateDrama(
    client: PoolClient,
    owner: string,
    fields: {
      dramaId?: string;
      dramaTitle?: string;
      dramaSynopsis?: string;
      seriesGroup?: string | null;
      title: string;
      logline?: string;
      styleKey: string;
      aspectRatio: ComicDramaSeries["aspectRatio"];
      videoModel: string | null;
    },
  ): Promise<{ drama: ComicDrama; created: boolean }> {
    if (fields.dramaId) {
      return { drama: await this.dramaRow(client, owner, fields.dramaId, true), created: false };
    }
    const groupTitle = fields.seriesGroup?.trim();
    if (groupTitle) {
      const { rows } = await client.query<DramaRow>(
        `SELECT ${dramaFields} FROM lot_comic_drama.cd_dramas
         WHERE owner_id=$1 AND title=$2 AND deleted_at IS NULL AND archived_at IS NULL
         ORDER BY updated_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        [owner, groupTitle],
      );
      if (rows[0]) return { drama: asDrama(rows[0]), created: false };
      const { rows: [inserted] } = await client.query<DramaRow>(
        `INSERT INTO lot_comic_drama.cd_dramas(owner_id,title,synopsis,style_key,aspect_ratio,video_model)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${dramaFields}`,
        [owner, groupTitle, fields.dramaSynopsis ?? "", fields.styleKey, fields.aspectRatio, fields.videoModel ?? null],
      );
      return { drama: asDrama(inserted), created: true };
    }
    const dramaTitle = fields.dramaTitle?.trim() || fields.title;
    const dramaSynopsis = fields.dramaSynopsis ?? fields.logline ?? "";
    const { rows: [inserted] } = await client.query<DramaRow>(
      `INSERT INTO lot_comic_drama.cd_dramas(owner_id,title,synopsis,style_key,aspect_ratio,video_model)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${dramaFields}`,
      [owner, dramaTitle, dramaSynopsis, fields.styleKey, fields.aspectRatio, fields.videoModel ?? null],
    );
    return { drama: asDrama(inserted), created: true };
  }

  create(owner: string, fields: ComicDramaSeriesInput): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      let styleKey = fields.styleKey;
      let parentId: string | null = null;
      let sourceDramaId = fields.dramaId;
      const inherit = fields.inheritCastAndStyle !== false;
      if (fields.sourceSeriesId) {
        const source = await this.series(client, owner, fields.sourceSeriesId);
        parentId = source.id;
        sourceDramaId ??= source.dramaId;
        if (inherit) styleKey = source.styleKey;
      }
      await requireComicChoice(client, owner, "style", styleKey);
      const { drama, created } = await this.resolveOrCreateDrama(client, owner, {
        ...fields,
        dramaId: sourceDramaId,
        styleKey,
      });
      const episodeNo = fields.episodeNo ?? (created ? 1 : await this.nextEpisodeNo(client, owner, drama.id));
      const series = await this.insert(client, owner, {
        ...fields,
        dramaId: drama.id,
        seriesGroup: drama.title,
        episodeNo,
        styleKey,
      }, parentId);
      if (parentId && inherit) {
        await client.query(`INSERT INTO lot_comic_drama.cd_series_cast(owner_id,series_id,character_id,outfit_id,snapshot)
          SELECT owner_id,$1,character_id,outfit_id,snapshot FROM lot_comic_drama.cd_series_cast WHERE owner_id=$2 AND series_id=$3`,
          [series.id, owner, parentId]);
      } else if (!created && inherit) {
        await syncDramaCastToSeries(client, owner, drama.id, series.id);
      }
      await this.touchDrama(client, owner, drama.id);
      await this.setCurrent(client, owner, series.id, drama.id);
      const cast = (parentId || !created) && inherit ? await readSeriesCast(client, series.id) : [];
      return this.buildDetail(client, owner, series, [], null, cast, 0, 0);
    });
  }

  derive(owner: string, id: string, sequel: boolean, inheritCastAndStyle = true): Promise<ComicDramaDetail> {
    return this.transaction(client => this.deriveOn(client, owner, id, sequel, inheritCastAndStyle));
  }

  async deriveOn(client: PoolClient, owner: string, id: string, sequel: boolean, inheritCastAndStyle = true): Promise<ComicDramaDetail> {
    const source = await this.series(client, owner, id, true);
    const drama = await this.dramaRow(client, owner, source.dramaId, true);
    const nextNo = sequel ? await this.nextEpisodeNo(client, owner, drama.id) : (source.episodeNo ?? 1);
    const episodeNo = sequel ? Math.min(Math.max((source.episodeNo ?? 1) + 1, nextNo), 2_147_483_647) : nextNo;
    const suffix = sequel ? ` #${episodeNo}` : " (copy)";
    const title = (sequel ? drama.title : source.title).slice(0, 120 - suffix.length).replace(/[\uD800-\uDBFF]$/u, "") + suffix;
    const inherit = !sequel || inheritCastAndStyle;
    const styleKey = inherit ? source.styleKey :
      (await readComicDictionary(client, owner, "style")).find(style => !style.inactive)?.key ?? "thick_painting";
    const series = await this.insert(client, owner, {
      ...source,
      dramaId: drama.id,
      styleKey,
      title,
      episodeNo,
      seriesGroup: drama.title,
      logline: sequel ? "" : source.logline,
    }, sequel ? id : source.parentId);
    if (inherit) {
      await client.query(`INSERT INTO lot_comic_drama.cd_series_cast(owner_id,series_id,character_id,outfit_id,snapshot)
        SELECT owner_id,$1,character_id,outfit_id,snapshot FROM lot_comic_drama.cd_series_cast WHERE owner_id=$2 AND series_id=$3`,
        [series.id, owner, id]);
    }
    if (!sequel) {
      await client.query("INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft) SELECT $1,ordinal,draft FROM lot_comic_drama.cd_clips WHERE series_id=$2",
        [series.id, id]);
      await client.query(`INSERT INTO lot_comic_drama.cd_scripts(series_id,version,content,source)
        SELECT $1,1,content,source FROM lot_comic_drama.cd_scripts WHERE series_id=$2 ORDER BY version DESC LIMIT 1`, [series.id, id]);
    }
    await this.touchDrama(client, owner, drama.id);
    await this.setCurrent(client, owner, series.id, drama.id);
    const { clips, script, cast } = await this.content(client, series.id, series.revision);
    return this.buildDetail(client, owner, series, clips, script, cast, 0, 0);
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
      let targetDrama = await this.dramaRow(client, owner, current.dramaId, true);
      if (fields.dramaId && fields.dramaId !== current.dramaId) {
        targetDrama = await this.dramaRow(client, owner, fields.dramaId, true);
      } else if (fields.seriesGroup?.trim() && fields.seriesGroup.trim() !== targetDrama.title) {
        const nextGroup = fields.seriesGroup.trim();
        const { rows: [cnt] } = await client.query<{ total: number }>(
          "SELECT count(*)::int AS total FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND drama_id=$2 AND deleted_at IS NULL",
          [owner, targetDrama.id],
        );
        if ((cnt?.total ?? 0) <= 1) {
          const { rows: [renamed] } = await client.query<DramaRow>(
            `UPDATE lot_comic_drama.cd_dramas SET title=$2,updated_at=clock_timestamp()
             WHERE id=$1 RETURNING ${dramaFields}`,
            [targetDrama.id, nextGroup],
          );
          if (renamed) targetDrama = asDrama(renamed);
        } else {
          targetDrama = (await this.resolveOrCreateDrama(client, owner, {
            seriesGroup: nextGroup,
            title: fields.title,
            logline: fields.logline,
            styleKey: fields.styleKey,
            aspectRatio: fields.aspectRatio,
            videoModel: fields.videoModel,
          })).drama;
        }
      }
      const { title, logline, styleKey, aspectRatio, videoModel } = fields;
      const episodeNo = fields.episodeNo ?? current.episodeNo ?? 1;
      const { rows } = await client.query<SeriesRow>(
        `UPDATE lot_comic_drama.cd_series
         SET drama_id=$2,title=$3,logline=$4,series_group=$5,episode_no=$6,
           style_key=$7,aspect_ratio=$8,video_model=$9,revision=revision+1,updated_at=clock_timestamp()
         WHERE id=$1 RETURNING ${seriesFields}`,
        [id, targetDrama.id, title, logline, targetDrama.title, episodeNo, styleKey, aspectRatio, videoModel],
      );
      await this.touchDrama(client, owner, targetDrama.id);
      return asSeries(rows[0]);
    });
  }

  private async hide(owner: string, id: string, expected: number, column: "archived_at" | "deleted_at") {
    await this.transaction(async client => {
      // Lock archived rows too so they can still be deleted from history.
      const result = await client.query(
        "SELECT revision, drama_id AS \"dramaId\" FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        [owner, id],
      );
      if (!result.rows[0]) throw new ComicDramaError("NOT_FOUND");
      requireRevision(result.rows[0].revision, expected);
      await client.query(`UPDATE lot_comic_drama.cd_series SET ${column}=now(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [id]);
      await client.query("UPDATE lot_comic_drama.cd_user_state SET current_series_id=NULL WHERE owner_id=$1 AND current_series_id=$2", [owner, id]);
      if (result.rows[0].dramaId) await this.touchDrama(client, owner, String(result.rows[0].dramaId));
    });
  }

  archive(owner: string, id: string, expected: number) { return this.hide(owner, id, expected, "archived_at"); }
  remove(owner: string, id: string, expected: number) { return this.hide(owner, id, expected, "deleted_at"); }

  private async bump(client: PoolClient, id: string): Promise<number> {
    const { rows } = await client.query<{ revision: number; dramaId?: string | null }>(
      `UPDATE lot_comic_drama.cd_series SET revision=revision+1,updated_at=clock_timestamp()
       WHERE id=$1 RETURNING revision, drama_id AS "dramaId"`,
      [id],
    );
    if (rows[0]?.dramaId) {
      await client.query("UPDATE lot_comic_drama.cd_dramas SET updated_at=clock_timestamp() WHERE id=$1", [rows[0].dramaId]);
    }
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

  private async updateClipOn(
    client: PoolClient,
    owner: string,
    id: string,
    clipId: string,
    expectedRevision: number,
    draft: ComicDramaClipDraft,
  ): Promise<ComicDramaClip> {
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
    const existingMatKeys = new Set(collectDraftMaterialRefs(existing.draft).map(materialRefKey));
    const addedMats = collectDraftMaterialRefs(draft).filter(entry => !existingMatKeys.has(materialRefKey(entry)));
    if (addedMats.length) {
      const invalidMats = await inspectMaterialRefs(client, owner, addedMats);
      if (invalidMats.size > 0) throw new ComicDramaError("INVALID_MATERIAL_REFERENCE");
    }
    const { rows } = await client.query(`UPDATE lot_comic_drama.cd_clips SET draft=$2,revision=revision+1,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING ${clipFields}`, [clipId, draft]);
    return comicDramaClipSchema.parse(rows[0]);
  }

  saveClip(owner: string, id: string, clipId: string, { expectedRevision, expectedSeriesRevision, draft }: ComicDramaClipUpdate) {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id, true);
      if (expectedSeriesRevision !== undefined) requireRevision(series.revision, expectedSeriesRevision);
      const clip = await this.updateClipOn(client, owner, id, clipId, expectedRevision, draft);
      return { clip, seriesRevision: await this.bump(client, id) };
    });
  }

  async writeEnhancedClips(
    client: PoolClient,
    owner: string,
    id: string,
    expected: number,
    updates: ReadonlyArray<{ clipId: string; expectedClipRevision: number; draft: ComicDramaClipDraft }>,
  ): Promise<number> {
    const series = await this.series(client, owner, id, true);
    requireRevision(series.revision, expected);
    for (const update of updates) {
      await this.updateClipOn(client, owner, id, update.clipId, update.expectedClipRevision, update.draft);
    }
    return this.bump(client, id);
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
