import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  comicDramaClipDraftSchema, comicDramaIdSchema, comicEditUpdateSchema, comicTimelineSchema, comicVideoItem,
  emptyComicTimeline, layoutComicTimeline, planClipSfxPlacements,
  type ComicDramaEditEpisodeItem, type ComicDramaEditTaskEntry, type ComicDramaEditTaskSummary,
  type ComicDramaEditTaskView, type ComicEdit, type ComicEditAppendSource, type ComicEditAudioSource,
  type ComicEditCreate, type ComicEditLastSummary, type ComicEditList, type ComicEditListEntry,
  type ComicEditReplace, type ComicEditSource, type ComicEditUnaddedTake, type ComicEditUpdate, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";

const cd = "lot_comic_drama";
const joinedColumns = `e.id,e.series_id AS "seriesId",e.drama_edit_task_id AS "dramaEditTaskId",
  coalesce(s.drama_id,et.drama_id) AS "dramaId",
  coalesce(d.title,s.series_group,s.title) AS "dramaTitle",s.episode_no AS "episodeNo",
  s.title AS "episodeTitle",e.title,e.revision,e.updated_at AS "updatedAt",
  d.archived_at AS "dramaArchivedAt"`;
const joinSeries = `LEFT JOIN ${cd}.cd_edit_tasks et ON (et.owner_id,et.id)=(e.owner_id,e.drama_edit_task_id)
  LEFT JOIN ${cd}.cd_series s ON (s.owner_id,s.id)=(e.owner_id,e.series_id) AND s.deleted_at IS NULL
  LEFT JOIN ${cd}.cd_dramas d ON (d.owner_id,d.id)=(e.owner_id,coalesce(s.drama_id,et.drama_id)) AND d.deleted_at IS NULL`;
type EditRow = Omit<ComicEdit, "sources" | "audioSources" | "updatedAt" | "dramaArchivedAt" | "dramaEpisodes" | "unaddedAdoptedTakes"> & {
  updatedAt: Date;
  dramaArchivedAt?: Date | null;
};
type SourceRow = ComicEditSource & { seriesId: string };
type DramaRow = {
  id: string;
  title: string;
  synopsis: string;
  styleKey: string;
  aspectRatio: ComicTimeline["aspectRatio"];
  archivedAt: Date | null;
  updatedAt: Date;
};
type EditTaskRow = {
  id: string;
  dramaId: string;
  lastSeriesId: string | null;
  updatedAt: Date;
};
type EpisodeQueryRow = {
  seriesId: string;
  dramaId: string;
  episodeNo: number;
  title: string;
  logline: string;
  aspectRatio: ComicTimeline["aspectRatio"];
  archivedAt: Date | null;
  seriesUpdatedAt: Date;
  editId: string | null;
  editRevision: number | null;
  timeline: unknown;
  editUpdatedAt: Date | null;
  renderCount: number;
  hasReadyRender: boolean;
};
type EpisodeClipRow = {
  seriesId: string;
  clipId: string;
  ordinal: number;
  scene: string;
  adoptedTakeId: string | null;
  adoptedDurationMs: number | null;
};

function formatDramaEpisodeEditTitle(dramaTitle: string, episodeNo: number, episodeTitle: string): string {
  const prefix = `《${dramaTitle}》第 ${episodeNo} 集`;
  const cleanEp = episodeTitle.trim();
  const full = cleanEp && cleanEp !== dramaTitle ? `${prefix} · ${cleanEp}` : prefix;
  return full.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, "");
}

function isUntouchedEmptyTimeline(timeline: ComicTimeline): boolean {
  return timeline.video.length === 0
    && timeline.voice.length === 0
    && timeline.sfx.length === 0
    && timeline.music.length === 0
    && timeline.subtitles.length === 0;
}

export class ComicEditConflict extends ComicLibraryError {
  constructor(readonly currentRevision: number) { super("REVISION_CONFLICT", 409); }
}

export class PgComicEdits {
  constructor(private readonly pool: Pool) {}

  private async read(db: ComicQuery, owner: string, id: string, write = false): Promise<EditRow> {
    const { rows: [row] } = await db.query<EditRow>(
      `SELECT ${joinedColumns},e.timeline FROM ${cd}.cd_edits e
       ${joinSeries}
       WHERE e.owner_id=$1 AND e.id=$2
         AND (e.drama_edit_task_id IS NULL OR (s.id IS NOT NULL AND d.id IS NOT NULL))
       ${write ? "FOR UPDATE OF e" : "FOR SHARE OF e"}`,
      [owner, id],
    );
    if (!row) libraryMissing();
    return { ...row, timeline: comicTimelineSchema.parse(row.timeline) };
  }

  private async sources(db: ComicQuery, owner: string, takes: string[]): Promise<SourceRow[]> {
    if (!takes.length) return [];
    const { rows } = await db.query<SourceRow>(
      `SELECT t.id AS "takeId",t.media_id AS "mediaId",
        s.drama_id AS "dramaId",coalesce(d.title,s.series_group,s.title) AS "dramaTitle",s.episode_no AS "episodeNo",
        s.title AS "seriesTitle",s.id AS "seriesId",
        CASE WHEN s.deleted_at IS NULL THEN c.id END AS "clipId",
        CASE WHEN s.deleted_at IS NULL THEN c.ordinal END AS "clipOrdinal",
        coalesce(c.draft->>'scene','') AS scene,
        t.video_version AS version,m.duration_ms AS "durationMs",t.input->>'aspectRatio' AS "aspectRatio",
        coalesce(t.input->>'audioMode', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(coalesce(t.input->'timedReferences','[]'::jsonb)) tr WHERE tr->>'kind'='audio'
        ) THEN 'reference_audio' ELSE 'silent_tts' END) AS "audioMode",
        CASE WHEN a.id IS NOT NULL AND am.duration_ms IS NOT NULL
          THEN jsonb_build_object('takeId',a.id,'version',a.video_version,'durationMs',am.duration_ms) END AS adopted
        FROM ${cd}.cd_takes t JOIN ${cd}.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
        JOIN ${cd}.cd_series s ON (s.owner_id,s.id)=(t.owner_id,r.series_id)
        LEFT JOIN ${cd}.cd_dramas d ON (d.owner_id,d.id)=(s.owner_id,s.drama_id)
        JOIN ${cd}.cd_media m ON (m.owner_id,m.id)=(t.owner_id,t.media_id)
        LEFT JOIN ${cd}.cd_clips c ON c.id=t.target_id AND c.series_id=r.series_id AND s.deleted_at IS NULL
        LEFT JOIN ${cd}.cd_takes a ON (a.owner_id,a.id)=(t.owner_id,c.adopted_video_take_id)
          AND a.status='ready' AND a.video_version IS NOT NULL
        LEFT JOIN ${cd}.cd_media am ON (am.owner_id,am.id)=(a.owner_id,a.media_id)
        WHERE t.owner_id=$1 AND t.id=ANY($2::uuid[]) AND t.status='ready' AND t.video_version IS NOT NULL
          AND m.mime='video/mp4' AND m.duration_ms>0`,
      [owner, takes],
    );
    return rows;
  }

  private async findUnaddedAdoptedTakes(
    db: ComicQuery,
    owner: string,
    seriesId: string,
    timeline: ComicTimeline,
    sources: readonly SourceRow[],
  ): Promise<ComicEditUnaddedTake[]> {
    const presentTakeIds = new Set(timeline.video.map(item => item.takeId));
    const presentClipIds = new Set(
      sources.map(src => src.clipId).filter((clipId): clipId is string => Boolean(clipId)),
    );
    const { rows } = await db.query<EpisodeClipRow>(
      `SELECT c.series_id AS "seriesId", c.id AS "clipId", c.ordinal,
         coalesce(c.draft->>'scene', '') AS scene,
         c.adopted_video_take_id AS "adoptedTakeId",
         m.duration_ms AS "adoptedDurationMs"
       FROM ${cd}.cd_clips c
       JOIN ${cd}.cd_takes t ON t.owner_id=$1 AND t.id=c.adopted_video_take_id
         AND t.status='ready' AND t.video_version IS NOT NULL
       JOIN ${cd}.cd_media m ON (m.owner_id, m.id)=(t.owner_id, t.media_id)
         AND m.mime='video/mp4' AND m.duration_ms>0
       WHERE c.series_id=$2 AND c.adopted_video_take_id IS NOT NULL
       ORDER BY c.ordinal ASC`,
      [owner, seriesId],
    );
    return rows
      .filter(row => row.adoptedTakeId && row.adoptedDurationMs
        && !presentTakeIds.has(row.adoptedTakeId) && !presentClipIds.has(row.clipId))
      .map(row => ({
        clipId: row.clipId,
        ordinal: Number(row.ordinal),
        scene: row.scene,
        takeId: row.adoptedTakeId!,
        durationMs: Number(row.adoptedDurationMs),
      }));
  }

  private async buildEpisodeItemsForDramas(
    db: ComicQuery,
    owner: string,
    dramaIds: readonly string[],
    includeArchived = false,
    keepSeriesId: string | null = null,
  ): Promise<Map<string, ComicDramaEditEpisodeItem[]>> {
    const result = new Map<string, ComicDramaEditEpisodeItem[]>();
    if (!dramaIds.length) return result;
    const { rows: epRows } = await db.query<EpisodeQueryRow>(
      `SELECT s.id AS "seriesId", s.drama_id AS "dramaId", s.episode_no AS "episodeNo", s.title, s.logline,
         s.aspect_ratio AS "aspectRatio", s.archived_at AS "archivedAt", s.updated_at AS "seriesUpdatedAt",
         e.id AS "editId", e.revision AS "editRevision", e.timeline, e.updated_at AS "editUpdatedAt",
         (SELECT count(*)::int FROM ${cd}.cd_renders r
          WHERE r.owner_id=s.owner_id AND r.edit_id=e.id AND r.deleted_at IS NULL AND r.ephemeral=FALSE) AS "renderCount",
         EXISTS (SELECT 1 FROM ${cd}.cd_renders r
          WHERE r.owner_id=s.owner_id AND r.edit_id=e.id AND r.deleted_at IS NULL AND r.ephemeral=FALSE
            AND r.media_id IS NOT NULL) AS "hasReadyRender"
       FROM ${cd}.cd_series s
       JOIN ${cd}.cd_edit_tasks et ON et.owner_id=s.owner_id AND et.drama_id=s.drama_id
       LEFT JOIN ${cd}.cd_edits e ON e.owner_id=s.owner_id AND e.drama_edit_task_id=et.id AND e.series_id=s.id
       WHERE s.owner_id=$1 AND s.drama_id=ANY($2::uuid[]) AND s.deleted_at IS NULL
         AND ($3::boolean OR s.archived_at IS NULL OR ($4::uuid IS NOT NULL AND s.id=$4::uuid))
       ORDER BY s.episode_no ASC, s.created_at ASC, s.id ASC`,
      [owner, dramaIds, includeArchived, keepSeriesId],
    );
    const seriesIds = epRows.map(r => r.seriesId);
    const clipsBySeries = new Map<string, EpisodeClipRow[]>();
    const timelineTakeIds = new Set<string>();
    const parsedTimelines = new Map<string, ComicTimeline>();
    for (const row of epRows) {
      if (row.editId && row.timeline) {
        const parsed = comicTimelineSchema.safeParse(row.timeline);
        if (parsed.success) {
          parsedTimelines.set(row.seriesId, parsed.data);
          for (const item of parsed.data.video) timelineTakeIds.add(item.takeId);
        }
      }
    }
    if (seriesIds.length) {
      const { rows: clipRows } = await db.query<EpisodeClipRow>(
        `SELECT c.series_id AS "seriesId", c.id AS "clipId", c.ordinal,
           coalesce(c.draft->>'scene', '') AS scene,
           CASE WHEN t.id IS NOT NULL AND m.id IS NOT NULL THEN c.adopted_video_take_id ELSE NULL END AS "adoptedTakeId",
           m.duration_ms AS "adoptedDurationMs"
         FROM ${cd}.cd_clips c
         LEFT JOIN ${cd}.cd_takes t ON t.owner_id=$1 AND t.id=c.adopted_video_take_id
           AND t.status='ready' AND t.video_version IS NOT NULL
         LEFT JOIN ${cd}.cd_media m ON (m.owner_id, m.id)=(t.owner_id, t.media_id)
           AND m.mime='video/mp4' AND m.duration_ms>0
         WHERE c.series_id=ANY($2::uuid[])
         ORDER BY c.ordinal ASC`,
        [owner, seriesIds],
      );
      for (const clip of clipRows) {
        const list = clipsBySeries.get(clip.seriesId) ?? [];
        list.push(clip);
        clipsBySeries.set(clip.seriesId, list);
      }
    }
    const takeToClip = new Map<string, string>();
    if (timelineTakeIds.size) {
      const { rows: takeRows } = await db.query<{ takeId: string; clipId: string | null }>(
        `SELECT id AS "takeId", target_id AS "clipId" FROM ${cd}.cd_takes
         WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
        [owner, [...timelineTakeIds]],
      );
      for (const row of takeRows) {
        if (row.clipId) takeToClip.set(row.takeId, row.clipId);
      }
    }
    for (const row of epRows) {
      const clips = clipsBySeries.get(row.seriesId) ?? [];
      const adoptedByClip = new Map<string, string>();
      for (const clip of clips) {
        if (clip.adoptedTakeId) adoptedByClip.set(clip.clipId, clip.adoptedTakeId);
      }
      const timeline = parsedTimelines.get(row.seriesId);
      let timelineClipCount = 0;
      let timelineDurationMs = 0;
      let unaddedAdoptedCount = adoptedByClip.size;
      let outdatedAdoptedCount = 0;
      if (timeline) {
        timelineClipCount = timeline.video.length;
        timelineDurationMs = layoutComicTimeline(timeline).durationMs;
        const presentTakes = new Set(timeline.video.map(v => v.takeId));
        const presentClips = new Set<string>();
        for (const item of timeline.video) {
          const clipId = takeToClip.get(item.takeId);
          if (clipId) {
            presentClips.add(clipId);
            const currentAdopted = adoptedByClip.get(clipId);
            if (currentAdopted && currentAdopted !== item.takeId) outdatedAdoptedCount += 1;
          }
        }
        unaddedAdoptedCount = [...adoptedByClip.entries()].filter(
          ([clipId, takeId]) => !presentTakes.has(takeId) && !presentClips.has(clipId),
        ).length;
      }
      const updatedAt = (row.editUpdatedAt ?? row.seriesUpdatedAt).toISOString();
      const list = result.get(row.dramaId) ?? [];
      list.push({
        seriesId: row.seriesId,
        episodeNo: Number(row.episodeNo ?? 1),
        title: row.title,
        logline: row.logline,
        aspectRatio: row.aspectRatio,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        clipCount: clips.length,
        adoptedClipCount: adoptedByClip.size,
        editId: row.editId ?? null,
        editRevision: row.editRevision !== null ? Number(row.editRevision) : null,
        timelineClipCount,
        timelineDurationMs,
        unaddedAdoptedCount,
        outdatedAdoptedCount,
        renderCount: Number(row.renderCount ?? 0),
        hasReadyRender: Boolean(row.hasReadyRender),
        updatedAt,
      });
      result.set(row.dramaId, list);
    }
    return result;
  }

  private async detail(
    db: ComicQuery,
    owner: string,
    row: EditRow,
    refs: { sources: SourceRow[]; audioSources: ComicEditAudioSource[] },
    includeDramaEpisodes = false,
  ): Promise<ComicEdit> {
    const taskKind = row.dramaEditTaskId ? "drama" as const : "free" as const;
    const [unaddedAdoptedTakes, episodeMap] = await Promise.all([
      row.seriesId ? this.findUnaddedAdoptedTakes(db, owner, row.seriesId, row.timeline, refs.sources) : Promise.resolve([]),
      includeDramaEpisodes && row.dramaEditTaskId && row.dramaId
        ? this.buildEpisodeItemsForDramas(db, owner, [row.dramaId], Boolean(row.dramaArchivedAt), row.seriesId)
        : Promise.resolve(undefined),
    ]);
    const dramaEpisodes = episodeMap && row.dramaId ? (episodeMap.get(row.dramaId) ?? []) : undefined;
    return {
      id: row.id,
      seriesId: row.seriesId,
      dramaId: row.dramaId ?? null,
      dramaTitle: row.dramaTitle ?? null,
      episodeNo: row.episodeNo ?? null,
      episodeTitle: row.episodeTitle ?? null,
      taskKind,
      dramaEditTaskId: row.dramaEditTaskId ?? null,
      dramaArchivedAt: row.dramaArchivedAt?.toISOString() ?? null,
      ...(dramaEpisodes ? { dramaEpisodes } : {}),
      ...(row.seriesId ? { unaddedAdoptedTakes } : {}),
      title: row.title,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      audioSources: refs.audioSources,
      sources: refs.sources,
      timeline: row.timeline,
    };
  }

  private async rememberLastEdit(db: ComicQuery, owner: string, editId: string) {
    await db.query(
      `INSERT INTO ${cd}.cd_user_state(owner_id, editor_last_id) VALUES ($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET editor_last_id = excluded.editor_last_id`,
      [owner, editId],
    );
  }

  private async validateReferences(db: ComicQuery, owner: string, timeline: ComicTimeline) {
    const takes = [...new Set(timeline.video.map(item => item.takeId))];
    const sources = await this.sources(db, owner, takes);
    const byTake = new Map(sources.map(source => [source.takeId, source]));
    if (sources.length !== takes.length) throw new ComicLibraryError("EDIT_SOURCE_UNAVAILABLE", 404);
    if (timeline.video.some(item => byTake.get(item.takeId)?.durationMs !== item.sourceDurationMs)) {
      throw new ComicLibraryError("EDIT_SOURCE_DURATION_CHANGED", 409);
    }
    const audio = [...timeline.voice, ...timeline.music, ...timeline.sfx];
    const audioIds = [...new Set(audio.map(item => item.mediaId))];
    let audioSources: ComicEditAudioSource[] = [];
    if (audioIds.length) {
      const { rows } = await db.query<ComicEditAudioSource>(
        `SELECT id,duration_ms AS "durationMs" FROM ${cd}.cd_media
         WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND mime IN ('audio/mpeg','audio/wav') AND duration_ms>0`,
        [owner, audioIds],
      );
      if (rows.length !== audioIds.length) throw new ComicLibraryError("EDIT_SOURCE_UNAVAILABLE", 404);
      audioSources = rows;
      const length = new Map(rows.map(row => [row.id, row.durationMs]));
      if (audio.some(item => {
        const sourceLength = length.get(item.mediaId)!;
        return item.sourceInMs >= sourceLength || (!item.loop && item.sourceInMs + item.durationMs > sourceLength);
      })) throw new ComicLibraryError("INVALID_AUDIO_TRIM", 400);
    }
    const media = [...new Set([...sources.map(source => source.mediaId), ...audioIds])];
    return { takes, sources, media, audioSources };
  }

  async snapshot(db: ComicQuery, owner: string, id: string, revision: number) {
    const row = await this.read(db, owner, id);
    if (row.revision !== revision) throw new ComicEditConflict(row.revision);
    return {
      timeline: row.timeline,
      title: row.title,
      seriesId: row.seriesId,
      ...await this.validateReferences(db, owner, row.timeline),
    };
  }

  private async refs(db: ComicQuery, owner: string, editId: string, timeline: ComicTimeline) {
    const { takes, sources, media, audioSources } = await this.validateReferences(db, owner, timeline);
    await db.query(`DELETE FROM ${cd}.cd_edit_takes WHERE owner_id=$1 AND edit_id=$2`, [owner, editId]);
    await db.query(`DELETE FROM ${cd}.cd_edit_media WHERE owner_id=$1 AND edit_id=$2`, [owner, editId]);
    await db.query(
      `INSERT INTO ${cd}.cd_edit_takes(owner_id,edit_id,take_id) SELECT $1,$2,unnest($3::uuid[])`,
      [owner, editId, takes],
    );
    await db.query(
      `INSERT INTO ${cd}.cd_edit_media(owner_id,edit_id,media_id) SELECT $1,$2,unnest($3::uuid[])`,
      [owner, editId, media],
    );
    return { sources, audioSources };
  }

  async list(owner: string, cursor?: string): Promise<ComicEditList> {
    const [stamp, id, extra] = cursor?.split(",") ?? [];
    if (cursor && (extra !== undefined || !stamp || !Number.isFinite(Date.parse(stamp)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicLibraryError("INVALID_CURSOR", 400);
    }
    type ListEntryRow = Omit<ComicEditListEntry, "updatedAt"> & { updatedAt: Date; stamp: string };
    type LastEditRow = ComicEditLastSummary;
    type DramaTaskListRow = {
      id: string;
      dramaId: string;
      dramaTitle: string;
      synopsis: string;
      styleKey: string;
      aspectRatio: ComicTimeline["aspectRatio"];
      archivedAt: Date | null;
      lastSeriesId: string | null;
      updatedAt: Date;
      coverMediaId: string | null;
    };
    const [{ rows }, { rows: [lastRow] }, dramaTaskRows] = await Promise.all([
      this.pool.query<ListEntryRow>(
        `SELECT ${joinedColumns},e.updated_at::text AS stamp FROM ${cd}.cd_edits e ${joinSeries}
         WHERE e.owner_id=$1 AND e.drama_edit_task_id IS NULL
         AND ($2::timestamptz IS NULL OR (e.updated_at,e.id)<($2,$3::uuid))
         ORDER BY e.updated_at DESC,e.id DESC LIMIT 25`,
        [owner, stamp ?? null, id ?? null],
      ),
      this.pool.query<LastEditRow>(
        `SELECT e.id, e.title,
           CASE WHEN e.drama_edit_task_id IS NOT NULL THEN 'drama' ELSE 'free' END AS "taskKind",
           coalesce(s.drama_id, et.drama_id) AS "dramaId",
           coalesce(d.title, s.series_group, s.title) AS "dramaTitle",
           e.series_id AS "seriesId",
           s.episode_no AS "episodeNo",
           s.title AS "episodeTitle"
         FROM ${cd}.cd_user_state u
         JOIN ${cd}.cd_edits e ON (e.owner_id, e.id)=(u.owner_id, u.editor_last_id)
         LEFT JOIN ${cd}.cd_edit_tasks et ON (et.owner_id, et.id)=(e.owner_id, e.drama_edit_task_id)
         LEFT JOIN ${cd}.cd_series s ON (s.owner_id, s.id)=(e.owner_id, e.series_id) AND s.deleted_at IS NULL
         LEFT JOIN ${cd}.cd_dramas d ON (d.owner_id, d.id)=(e.owner_id, coalesce(s.drama_id, et.drama_id)) AND d.deleted_at IS NULL
         WHERE u.owner_id=$1
           AND (e.drama_edit_task_id IS NULL
             OR (s.id IS NOT NULL AND s.archived_at IS NULL AND d.id IS NOT NULL AND d.archived_at IS NULL))`,
        [owner],
      ),
      cursor ? Promise.resolve([] as DramaTaskListRow[]) : this.pool.query<DramaTaskListRow>(
        `SELECT t.id, t.drama_id AS "dramaId", d.title AS "dramaTitle", d.synopsis,
           d.style_key AS "styleKey", d.aspect_ratio AS "aspectRatio", d.archived_at AS "archivedAt",
           t.last_series_id AS "lastSeriesId", t.updated_at AS "updatedAt",
           (SELECT coalesce(c.keyframe_media_id, kt.media_id)
            FROM ${cd}.cd_series s
            JOIN ${cd}.cd_clips c ON c.series_id=s.id
            LEFT JOIN ${cd}.cd_takes kt ON kt.owner_id=s.owner_id AND kt.id=c.keyframe_take_id AND kt.status='ready'
            WHERE s.owner_id=t.owner_id AND s.drama_id=t.drama_id AND s.deleted_at IS NULL AND s.archived_at IS NULL
              AND (c.keyframe_media_id IS NOT NULL OR kt.media_id IS NOT NULL)
            ORDER BY s.episode_no ASC, (c.adopted_video_take_id IS NOT NULL) DESC, c.ordinal ASC LIMIT 1) AS "coverMediaId"
         FROM ${cd}.cd_edit_tasks t
         JOIN ${cd}.cd_dramas d ON (d.owner_id, d.id)=(t.owner_id, t.drama_id)
         WHERE t.owner_id=$1 AND d.deleted_at IS NULL AND d.archived_at IS NULL
         ORDER BY t.updated_at DESC, t.id DESC LIMIT 100`,
        [owner],
      ).then(r => r.rows),
    ]);
    let dramaTasks: ComicDramaEditTaskEntry[] | undefined;
    if (!cursor) {
      const episodesMap = await this.buildEpisodeItemsForDramas(
        this.pool,
        owner,
        dramaTaskRows.map(r => r.dramaId),
      );
      dramaTasks = dramaTaskRows.map(row => {
        const episodes = episodesMap.get(row.dramaId) ?? [];
        const activeLast = episodes.find(ep => ep.seriesId === row.lastSeriesId) ?? null;
        return {
          id: row.id,
          dramaId: row.dramaId,
          dramaTitle: row.dramaTitle,
          synopsis: row.synopsis,
          styleKey: row.styleKey,
          aspectRatio: row.aspectRatio,
          archivedAt: row.archivedAt?.toISOString() ?? null,
          lastSeriesId: activeLast?.seriesId ?? episodes[0]?.seriesId ?? null,
          lastEpisodeNo: activeLast?.episodeNo ?? episodes[0]?.episodeNo ?? null,
          lastEpisodeTitle: activeLast?.title ?? episodes[0]?.title ?? null,
          episodeCount: episodes.length,
          editedEpisodeCount: episodes.filter(ep => ep.timelineClipCount > 0).length,
          exportedEpisodeCount: episodes.filter(ep => ep.hasReadyRender).length,
          coverMediaId: row.coverMediaId ?? null,
          updatedAt: row.updatedAt.toISOString(),
          episodes,
        };
      });
    }
    const last = rows[23];
    return {
      entries: rows.slice(0, 24).map(({ stamp: _stamp, updatedAt, ...row }) => ({
        ...row,
        taskKind: "free" as const,
        updatedAt: updatedAt.toISOString(),
      })),
      ...(dramaTasks ? { dramaTasks } : {}),
      nextCursor: rows.length > 24 ? `${last.stamp},${last.id}` : null,
      lastEditId: lastRow?.id ?? null,
      lastEdit: lastRow ?? null,
    };
  }

  get(owner: string, id: string): Promise<ComicEdit> {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id);
      const refs = await this.validateReferences(db, owner, row.timeline);
      if (!row.dramaArchivedAt) await this.rememberLastEdit(db, owner, id);
      return this.detail(db, owner, row, refs, Boolean(row.dramaEditTaskId));
    });
  }

  private async initialClipSfx(
    db: ComicQuery,
    owner: string,
    items: Array<{ videoItem: ComicTimeline["video"][number]; clipId: string | null }>,
    maxItems = 1200,
  ): Promise<ComicTimeline["sfx"]> {
    const clipIds = [...new Set(items.map(entry => entry.clipId).filter((id): id is string => Boolean(id)))];
    if (!clipIds.length || maxItems <= 0) return [];
    const { rows: clipRows } = await db.query<{ id: string; draft: unknown }>(
      `SELECT c.id, c.draft FROM ${cd}.cd_clips c
       JOIN ${cd}.cd_series s ON s.id=c.series_id
       WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND c.id=ANY($2::uuid[])`,
      [owner, clipIds],
    );
    const draftsByClip = new Map<string, ReturnType<typeof comicDramaClipDraftSchema.parse>>();
    const mediaIds = new Set<string>();
    for (const row of clipRows) {
      const parsed = comicDramaClipDraftSchema.safeParse(row.draft);
      if (!parsed.success) continue;
      draftsByClip.set(row.id, parsed.data);
      for (const ref of parsed.data.sfxRefs ?? []) mediaIds.add(ref.mediaId);
      for (const shot of parsed.data.shots) {
        for (const ref of shot.sfxRefs ?? []) mediaIds.add(ref.mediaId);
      }
    }
    if (!mediaIds.size) return [];
    const { rows: audioRows } = await db.query<{ id: string; durationMs: number }>(
      `SELECT id, duration_ms AS "durationMs" FROM ${cd}.cd_media
       WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND mime IN ('audio/mpeg','audio/wav') AND duration_ms>0`,
      [owner, [...mediaIds]],
    );
    const durations = new Map(audioRows.map(row => [row.id, Number(row.durationMs)]));
    const sfx: ComicTimeline["sfx"] = [];
    for (const { videoItem, clipId } of items) {
      if (!clipId) continue;
      const draft = draftsByClip.get(clipId);
      if (!draft) continue;
      const placements = planClipSfxPlacements(draft, videoItem.id, videoItem.outMs - videoItem.inMs, durations, randomUUID);
      for (const placement of placements) {
        if (sfx.length >= maxItems) return sfx;
        sfx.push(placement);
      }
    }
    return sfx;
  }

  private async buildSeriesSeedTimeline(
    db: ComicQuery,
    owner: string,
    seriesId: string,
    aspectOverride?: ComicTimeline["aspectRatio"],
  ) {
    const { rows: [series] } = await db.query<{ aspect: ComicTimeline["aspectRatio"]; adopted: string[] }>(
      `SELECT aspect_ratio AS aspect, ARRAY(SELECT adopted_video_take_id FROM ${cd}.cd_clips
        WHERE series_id=s.id AND adopted_video_take_id IS NOT NULL ORDER BY ordinal LIMIT 201) AS adopted
      FROM ${cd}.cd_series s WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
      [owner, seriesId],
    );
    if (!series) libraryMissing();
    if (series.adopted.length > 200) throw new ComicLibraryError("EDIT_SOURCE_LIMIT", 400);
    const found = new Map((await this.sources(db, owner, series.adopted)).map(source => [source.takeId, source]));
    const initial = series.adopted.map(id => found.get(id) ?? libraryMissing());
    const timeline = emptyComicTimeline(aspectOverride ?? series.aspect);
    const paired = initial.map(source => ({ videoItem: comicVideoItem(randomUUID(), source), clipId: source.clipId }));
    timeline.video = paired.map(entry => entry.videoItem);
    timeline.sfx = await this.initialClipSfx(db, owner, paired);
    return { aspect: series.aspect, timeline };
  }

  getDramaTask(owner: string, dramaId: string, requestedSeriesId?: string): Promise<ComicDramaEditTaskView> {
    return libraryTransaction(this.pool, async db => {
      const { rows: [drama] } = await db.query<DramaRow>(
        `SELECT id, title, synopsis, style_key AS "styleKey", aspect_ratio AS "aspectRatio",
           archived_at AS "archivedAt", updated_at AS "updatedAt"
         FROM ${cd}.cd_dramas WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL`,
        [owner, dramaId],
      );
      if (!drama) libraryMissing();
      const { rows: [taskRow] } = await db.query<EditTaskRow>(
        `SELECT id, drama_id AS "dramaId", last_series_id AS "lastSeriesId", updated_at AS "updatedAt"
         FROM ${cd}.cd_edit_tasks WHERE owner_id=$1 AND drama_id=$2`,
        [owner, dramaId],
      );
      const episodes = taskRow
        ? ((await this.buildEpisodeItemsForDramas(
          db, owner, [dramaId], Boolean(drama.archivedAt), requestedSeriesId ?? null,
        )).get(dramaId) ?? [])
        : [];
      if (requestedSeriesId && !episodes.some(ep => ep.seriesId === requestedSeriesId)) {
        libraryMissing();
      }
      const activeSeriesId = requestedSeriesId
        ?? (episodes.some(ep => ep.seriesId === taskRow?.lastSeriesId && !ep.archivedAt) ? taskRow!.lastSeriesId : null)
        ?? episodes.find(ep => !ep.archivedAt)?.seriesId
        ?? episodes[0]?.seriesId
        ?? null;
      const activeEp = activeSeriesId ? episodes.find(ep => ep.seriesId === activeSeriesId) : undefined;
      let edit: ComicEdit | null = null;
      if (activeEp?.editId) {
        const row = await this.read(db, owner, activeEp.editId);
        const refs = await this.validateReferences(db, owner, row.timeline);
        edit = await this.detail(db, owner, row, refs);
        edit.dramaEpisodes = episodes;
      }
      const task: ComicDramaEditTaskSummary = {
        id: taskRow?.id ?? drama.id,
        dramaId: drama.id,
        dramaTitle: drama.title,
        synopsis: drama.synopsis,
        styleKey: drama.styleKey,
        aspectRatio: drama.aspectRatio,
        archivedAt: drama.archivedAt?.toISOString() ?? null,
        lastSeriesId: taskRow?.lastSeriesId ?? null,
        updatedAt: (taskRow?.updatedAt ?? drama.updatedAt).toISOString(),
      };
      return { task, episodes, activeSeriesId, edit };
    });
  }

  openDramaTask(owner: string, dramaId: string, requestedSeriesId?: string): Promise<ComicDramaEditTaskView> {
    return libraryTransaction(this.pool, async db => {
      const { rows: [drama] } = await db.query<DramaRow>(
        `SELECT id, title, synopsis, style_key AS "styleKey", aspect_ratio AS "aspectRatio",
           archived_at AS "archivedAt", updated_at AS "updatedAt"
         FROM ${cd}.cd_dramas WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
        [owner, dramaId],
      );
      if (!drama) libraryMissing();
      await db.query(
        `INSERT INTO ${cd}.cd_edit_tasks(owner_id,drama_id) VALUES ($1,$2)
         ON CONFLICT (owner_id,drama_id) DO NOTHING`,
        [owner, dramaId],
      );
      const { rows: [taskRow] } = await db.query<EditTaskRow>(
        `SELECT id, drama_id AS "dramaId", last_series_id AS "lastSeriesId", updated_at AS "updatedAt"
         FROM ${cd}.cd_edit_tasks WHERE owner_id=$1 AND drama_id=$2 FOR UPDATE`,
        [owner, dramaId],
      );
      let episodes = (await this.buildEpisodeItemsForDramas(
        db, owner, [dramaId], Boolean(drama.archivedAt), requestedSeriesId ?? null,
      )).get(dramaId) ?? [];
      if (requestedSeriesId && !episodes.some(ep => ep.seriesId === requestedSeriesId)) {
        libraryMissing();
      }
      const activeSeriesId = requestedSeriesId
        ?? (episodes.some(ep => ep.seriesId === taskRow.lastSeriesId && !ep.archivedAt) ? taskRow.lastSeriesId : null)
        ?? episodes.find(ep => !ep.archivedAt)?.seriesId
        ?? episodes[0]?.seriesId
        ?? null;
      let edit: ComicEdit | null = null;
      if (activeSeriesId) {
        const targetEp = episodes.find(ep => ep.seriesId === activeSeriesId)!;
        const { rows: [existing] } = await db.query<{ id: string }>(
          `SELECT id FROM ${cd}.cd_edits
           WHERE owner_id=$1 AND drama_edit_task_id=$2 AND series_id=$3 FOR UPDATE`,
          [owner, taskRow.id, activeSeriesId],
        );
        let editId = existing?.id;
        const canMutate = !drama.archivedAt && !targetEp.archivedAt;
        if (!editId) {
          if (!canMutate) throw new ComicLibraryError("EDIT_DRAMA_ARCHIVED", 409);
          const { timeline } = await this.buildSeriesSeedTimeline(db, owner, activeSeriesId);
          const defaultTitle = formatDramaEpisodeEditTitle(drama.title, targetEp.episodeNo, targetEp.title);
          const { rows: [inserted] } = await db.query<{ id: string }>(
            `INSERT INTO ${cd}.cd_edits(owner_id,series_id,drama_edit_task_id,title,timeline)
             VALUES($1,$2,$3,$4,$5) RETURNING id`,
            [owner, activeSeriesId, taskRow.id, defaultTitle, timeline],
          );
          editId = inserted.id;
          await this.refs(db, owner, editId, timeline);
        } else {
          const currentRow = await this.read(db, owner, editId, true);
          if (canMutate && currentRow.revision === 1 && isUntouchedEmptyTimeline(currentRow.timeline)) {
            const { timeline: seeded } = await this.buildSeriesSeedTimeline(db, owner, activeSeriesId, currentRow.timeline.aspectRatio);
            if (seeded.video.length > 0) {
              await this.refs(db, owner, editId, seeded);
              await db.query(
                `UPDATE ${cd}.cd_edits SET timeline=$3, updated_at=clock_timestamp()
                 WHERE owner_id=$1 AND id=$2`,
                [owner, editId, seeded],
              );
            }
          }
        }
        if (canMutate) {
          await db.query(
            `UPDATE ${cd}.cd_edit_tasks SET last_series_id=$3, updated_at=clock_timestamp()
             WHERE owner_id=$1 AND id=$2`,
            [owner, taskRow.id, activeSeriesId],
          );
          await this.rememberLastEdit(db, owner, editId);
          taskRow.lastSeriesId = activeSeriesId;
        }
        episodes = (await this.buildEpisodeItemsForDramas(
          db, owner, [dramaId], Boolean(drama.archivedAt), requestedSeriesId ?? null,
        )).get(dramaId) ?? [];
        const row = await this.read(db, owner, editId);
        const refs = await this.validateReferences(db, owner, row.timeline);
        edit = await this.detail(db, owner, row, refs);
        edit.dramaEpisodes = episodes;
      }
      const task: ComicDramaEditTaskSummary = {
        id: taskRow.id,
        dramaId: drama.id,
        dramaTitle: drama.title,
        synopsis: drama.synopsis,
        styleKey: drama.styleKey,
        aspectRatio: drama.aspectRatio,
        archivedAt: drama.archivedAt?.toISOString() ?? null,
        lastSeriesId: taskRow.lastSeriesId,
        updatedAt: taskRow.updatedAt.toISOString(),
      };
      return { task, episodes, activeSeriesId, edit };
    });
  }

  create(owner: string, fields: ComicEditCreate) {
    return libraryTransaction(this.pool, async db => {
      let aspect = fields.aspectRatio;
      let seriesId = fields.seriesId ?? null;
      let initial: SourceRow[] = [];
      if (fields.seriesId) {
        const { rows: [series] } = await db.query<{ aspect: ComicTimeline["aspectRatio"]; adopted: string[] }>(
          `SELECT aspect_ratio AS aspect, ARRAY(SELECT adopted_video_take_id FROM ${cd}.cd_clips
            WHERE series_id=s.id AND adopted_video_take_id IS NOT NULL ORDER BY ordinal LIMIT 201) AS adopted
          FROM ${cd}.cd_series s WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
          [owner, fields.seriesId],
        );
        if (!series) libraryMissing();
        aspect ??= series.aspect;
        if (!fields.takeId) {
          if (series.adopted.length > 200) throw new ComicLibraryError("EDIT_SOURCE_LIMIT", 400);
          const found = new Map((await this.sources(db, owner, series.adopted)).map(source => [source.takeId, source]));
          initial = series.adopted.map(id => found.get(id) ?? libraryMissing());
        }
      }
      if (fields.takeId) {
        const [exact] = await this.sources(db, owner, [fields.takeId]);
        if (!exact) throw new ComicLibraryError("EDIT_SOURCE_UNAVAILABLE", 404);
        initial = [exact];
        seriesId ??= exact.seriesId;
        aspect ??= exact.aspectRatio;
      }
      const timeline = emptyComicTimeline(aspect ?? "9:16");
      const paired = initial.map(source => ({ videoItem: comicVideoItem(randomUUID(), source), clipId: source.clipId }));
      timeline.video = paired.map(entry => entry.videoItem);
      timeline.sfx = await this.initialClipSfx(db, owner, paired);
      const { rows: [inserted] } = await db.query<{ id: string }>(
        `INSERT INTO ${cd}.cd_edits(owner_id,series_id,title,timeline) VALUES($1,$2,$3,$4) RETURNING id`,
        [owner, seriesId, fields.title, timeline],
      );
      const row = await this.read(db, owner, inserted.id);
      const refs = await this.refs(db, owner, row.id, timeline);
      await this.rememberLastEdit(db, owner, row.id);
      return this.detail(db, owner, row, refs);
    });
  }

  private async save(db: ComicQuery, owner: string, row: EditRow, title: string, timeline: ComicTimeline) {
    if (row.dramaArchivedAt) throw new ComicLibraryError("EDIT_DRAMA_ARCHIVED", 409);
    const sources = await this.refs(db, owner, row.id, timeline);
    await db.query(
      `UPDATE ${cd}.cd_edits SET title=$3,timeline=$4,revision=revision+1,updated_at=clock_timestamp()
       WHERE owner_id=$1 AND id=$2`,
      [owner, row.id, title, timeline],
    );
    if (row.dramaEditTaskId) {
      await db.query(
        `UPDATE ${cd}.cd_edit_tasks SET updated_at=clock_timestamp(), last_series_id=coalesce($3, last_series_id)
         WHERE owner_id=$1 AND id=$2`,
        [owner, row.dramaEditTaskId, row.seriesId],
      );
    }
    const next = await this.read(db, owner, row.id);
    await this.rememberLastEdit(db, owner, row.id);
    return this.detail(db, owner, next, sources, Boolean(next.dramaEditTaskId));
  }

  update(owner: string, id: string, fields: ComicEditUpdate) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id, true);
      if (row.revision !== fields.expectedRevision) throw new ComicEditConflict(row.revision);
      return this.save(db, owner, row, fields.title, fields.timeline);
    });
  }

  syncEpisodeSources(owner: string, id: string, expectedRevision: number) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id, true);
      if (row.revision !== expectedRevision) throw new ComicEditConflict(row.revision);
      if (row.dramaArchivedAt) throw new ComicLibraryError("EDIT_DRAMA_ARCHIVED", 409);
      if (!row.seriesId) libraryMissing();
      const refs = await this.validateReferences(db, owner, row.timeline);
      const unadded = await this.findUnaddedAdoptedTakes(db, owner, row.seriesId, row.timeline, refs.sources);
      if (!unadded.length) {
        return this.detail(db, owner, row, refs, Boolean(row.dramaEditTaskId));
      }
      if (row.timeline.video.length + unadded.length > 200) {
        throw new ComicLibraryError("EDIT_SOURCE_LIMIT", 400);
      }
      const addedSources = await this.sources(db, owner, unadded.map(u => u.takeId));
      const byTake = new Map(addedSources.map(s => [s.takeId, s]));
      const paired = unadded.map(entry => {
        const src = byTake.get(entry.takeId) ?? libraryMissing();
        return { videoItem: comicVideoItem(randomUUID(), src), clipId: src.clipId };
      });
      const existingOverlays = row.timeline.voice.length + row.timeline.sfx.length
        + row.timeline.music.length + row.timeline.subtitles.length;
      const appendedSfx = await this.initialClipSfx(db, owner, paired, Math.max(0, 1200 - existingOverlays));
      const timeline: ComicTimeline = {
        ...row.timeline,
        video: [...row.timeline.video, ...paired.map(p => p.videoItem)],
        sfx: [...row.timeline.sfx, ...appendedSfx],
      };
      return this.save(db, owner, row, row.title, timeline);
    });
  }

  appendSource(owner: string, id: string, fields: ComicEditAppendSource) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id, true);
      if (row.revision !== fields.expectedRevision) throw new ComicEditConflict(row.revision);
      if (row.timeline.video.length >= 200) throw new ComicLibraryError("EDIT_SOURCE_LIMIT", 400);
      const [exact] = await this.sources(db, owner, [fields.takeId]);
      if (!exact) throw new ComicLibraryError("EDIT_SOURCE_UNAVAILABLE", 404);
      const videoItem = comicVideoItem(randomUUID(), exact);
      const existingOverlays = row.timeline.voice.length + row.timeline.sfx.length
        + row.timeline.music.length + row.timeline.subtitles.length;
      const appendedSfx = await this.initialClipSfx(db, owner, [{ videoItem, clipId: exact.clipId }], Math.max(0, 1200 - existingOverlays));
      const timeline: ComicTimeline = {
        ...row.timeline,
        video: [...row.timeline.video, videoItem],
        sfx: [...row.timeline.sfx, ...appendedSfx],
      };
      return this.save(db, owner, row, row.title, timeline);
    });
  }

  replace(owner: string, id: string, itemId: string, fields: ComicEditReplace) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id, true);
      if (row.revision !== fields.expectedRevision) throw new ComicEditConflict(row.revision);
      const item = row.timeline.video.find(item => item.id === itemId);
      if (!item) libraryMissing();
      const [source] = await this.sources(db, owner, [item.takeId]);
      if (!source?.clipId) throw new ComicLibraryError("EDIT_ADOPTION_CHANGED", 409);
      const { rows: [clip] } = await db.query<{ takeId: string | null }>(
        `SELECT adopted_video_take_id AS "takeId" FROM ${cd}.cd_clips WHERE id=$1 AND series_id=$2 FOR SHARE`,
        [source.clipId, source.seriesId],
      );
      if (clip?.takeId !== fields.takeId) throw new ComicLibraryError("EDIT_ADOPTION_CHANGED", 409);
      const [adopted] = await this.sources(db, owner, [fields.takeId]);
      if (!adopted) throw new ComicLibraryError("EDIT_SOURCE_UNAVAILABLE", 404);
      const outMs = fields.outMs ?? item.outMs;
      if (outMs > adopted.durationMs || outMs <= item.inMs) throw new ComicLibraryError("EDIT_TRIM_REQUIRED", 409);
      const attached = [...row.timeline.voice, ...row.timeline.sfx, ...row.timeline.music, ...row.timeline.subtitles];
      if (attached.some(entry => entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id
        && entry.anchor.offsetMs + entry.durationMs > outMs - item.inMs)) {
        throw new ComicLibraryError("EDIT_ATTACHED_OVERFLOW", 409);
      }
      const timeline = {
        ...row.timeline,
        video: row.timeline.video.map(current =>
          current.id === item.id ? { ...item, takeId: adopted.takeId, sourceDurationMs: adopted.durationMs, outMs } : current),
      };
      if (!comicEditUpdateSchema.safeParse({ title: row.title, expectedRevision: row.revision, timeline }).success) {
        throw new ComicLibraryError("EDIT_TRIM_REQUIRED", 409);
      }
      return this.save(db, owner, row, row.title, timeline);
    });
  }

  remove(owner: string, id: string, revision: number) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id, true);
      if (row.dramaEditTaskId) throw new ComicLibraryError("EDIT_DRAMA_BOUND", 409);
      if (row.revision !== revision) throw new ComicEditConflict(row.revision);
      await db.query(`DELETE FROM ${cd}.cd_edits WHERE owner_id=$1 AND id=$2`, [owner, id]);
    });
  }
}
