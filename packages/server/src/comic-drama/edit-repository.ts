import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  comicDramaClipDraftSchema, comicDramaIdSchema, comicEditUpdateSchema, comicTimelineSchema, comicVideoItem, emptyComicTimeline,
  planClipSfxPlacements, type ComicEdit, type ComicEditAppendSource, type ComicEditAudioSource, type ComicEditCreate, type ComicEditList,
  type ComicEditListEntry, type ComicEditReplace, type ComicEditSource, type ComicEditUpdate, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";

const cd = "lot_comic_drama";
const columns = 'id,series_id AS "seriesId",title,revision,updated_at AS "updatedAt"';
type EditRow = Omit<ComicEdit, "sources" | "audioSources" | "updatedAt"> & { updatedAt: Date };
type SourceRow = ComicEditSource & { seriesId: string };

export class ComicEditConflict extends ComicLibraryError {
  constructor(readonly currentRevision: number) { super("REVISION_CONFLICT", 409); }
}

export class PgComicEdits {
  constructor(private readonly pool: Pool) {}

  private async read(db: ComicQuery, owner: string, id: string, write = false): Promise<EditRow> {
    const { rows: [row] } = await db.query<EditRow>(`SELECT ${columns},timeline FROM ${cd}.cd_edits
      WHERE owner_id=$1 AND id=$2 ${write ? "FOR UPDATE" : "FOR SHARE"}`, [owner, id]);
    if (!row) libraryMissing();
    return { ...row, timeline: comicTimelineSchema.parse(row.timeline) };
  }

  private async sources(db: ComicQuery, owner: string, takes: string[]): Promise<SourceRow[]> {
    if (!takes.length) return [];
    const { rows } = await db.query<SourceRow>(`SELECT t.id AS "takeId",t.media_id AS "mediaId",s.title AS "seriesTitle",
      s.id AS "seriesId",CASE WHEN s.deleted_at IS NULL THEN c.id END AS "clipId",coalesce(c.draft->>'scene','') AS scene,
      t.video_version AS version,m.duration_ms AS "durationMs",t.input->>'aspectRatio' AS "aspectRatio",
      CASE WHEN a.id IS NOT NULL AND am.duration_ms IS NOT NULL
        THEN jsonb_build_object('takeId',a.id,'version',a.video_version,'durationMs',am.duration_ms) END AS adopted
      FROM ${cd}.cd_takes t JOIN ${cd}.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
      JOIN ${cd}.cd_series s ON (s.owner_id,s.id)=(t.owner_id,r.series_id)
      JOIN ${cd}.cd_media m ON (m.owner_id,m.id)=(t.owner_id,t.media_id)
      LEFT JOIN ${cd}.cd_clips c ON c.id=t.target_id AND c.series_id=r.series_id AND s.deleted_at IS NULL
      LEFT JOIN ${cd}.cd_takes a ON (a.owner_id,a.id)=(t.owner_id,c.adopted_video_take_id) AND a.status='ready' AND a.video_version IS NOT NULL
      LEFT JOIN ${cd}.cd_media am ON (am.owner_id,am.id)=(a.owner_id,a.media_id)
      WHERE t.owner_id=$1 AND t.id=ANY($2::uuid[]) AND t.status='ready' AND t.video_version IS NOT NULL
        AND m.mime='video/mp4' AND m.duration_ms>0`, [owner, takes]);
    return rows;
  }

  private detail(row: EditRow, refs: { sources: SourceRow[]; audioSources: ComicEditAudioSource[] }): ComicEdit {
    return { ...row, updatedAt: row.updatedAt.toISOString(), audioSources: refs.audioSources, sources: refs.sources };
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
      const { rows } = await db.query<ComicEditAudioSource>(`SELECT id,duration_ms AS "durationMs" FROM ${cd}.cd_media
        WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND mime IN ('audio/mpeg','audio/wav') AND duration_ms>0`, [owner, audioIds]);
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
    return { timeline: row.timeline, title: row.title, seriesId: row.seriesId, ...await this.validateReferences(db, owner, row.timeline) };
  }

  private async refs(db: ComicQuery, owner: string, editId: string, timeline: ComicTimeline) {
    const { takes, sources, media, audioSources } = await this.validateReferences(db, owner, timeline);
    await db.query(`DELETE FROM ${cd}.cd_edit_takes WHERE owner_id=$1 AND edit_id=$2`, [owner, editId]);
    await db.query(`DELETE FROM ${cd}.cd_edit_media WHERE owner_id=$1 AND edit_id=$2`, [owner, editId]);
    await db.query(`INSERT INTO ${cd}.cd_edit_takes(owner_id,edit_id,take_id) SELECT $1,$2,unnest($3::uuid[])`, [owner, editId, takes]);
    await db.query(`INSERT INTO ${cd}.cd_edit_media(owner_id,edit_id,media_id) SELECT $1,$2,unnest($3::uuid[])`, [owner, editId, media]);
    return { sources, audioSources };
  }

  async list(owner: string, cursor?: string): Promise<ComicEditList> {
    const [stamp, id, extra] = cursor?.split(",") ?? [];
    if (cursor && (extra !== undefined || !stamp || !Number.isFinite(Date.parse(stamp)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicLibraryError("INVALID_CURSOR", 400);
    }
    const [{ rows }, { rows: [stateRow] }] = await Promise.all([
      this.pool.query<Omit<ComicEditListEntry, "updatedAt"> & { updatedAt: Date; stamp: string }>(
        `SELECT ${columns},updated_at::text AS stamp FROM ${cd}.cd_edits WHERE owner_id=$1
        AND ($2::timestamptz IS NULL OR (updated_at,id)<($2,$3::uuid)) ORDER BY updated_at DESC,id DESC LIMIT 25`,
        [owner, stamp ?? null, id ?? null],
      ),
      this.pool.query<{ editorLastId: string | null }>(
        `SELECT editor_last_id AS "editorLastId" FROM ${cd}.cd_user_state WHERE owner_id=$1`, [owner],
      ),
    ]);
    const last = rows[23];
    return {
      entries: rows.slice(0, 24).map(({ stamp: _stamp, updatedAt, ...row }) => ({ ...row, updatedAt: updatedAt.toISOString() })),
      nextCursor: rows.length > 24 ? `${last.stamp},${last.id}` : null,
      lastEditId: stateRow?.editorLastId ?? null,
    };
  }

  get(owner: string, id: string): Promise<ComicEdit> {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id);
      const refs = await this.validateReferences(db, owner, row.timeline);
      await this.rememberLastEdit(db, owner, id);
      return this.detail(row, refs);
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

  create(owner: string, fields: ComicEditCreate) {
    return libraryTransaction(this.pool, async db => {
      let aspect = fields.aspectRatio;
      let seriesId = fields.seriesId ?? null;
      let initial: SourceRow[] = [];
      if (fields.seriesId) {
        const { rows: [series] } = await db.query<{ aspect: ComicTimeline["aspectRatio"]; adopted: string[] }>(
          `SELECT aspect_ratio AS aspect, ARRAY(SELECT adopted_video_take_id FROM ${cd}.cd_clips
            WHERE series_id=s.id AND adopted_video_take_id IS NOT NULL ORDER BY ordinal LIMIT 201) AS adopted
          FROM ${cd}.cd_series s WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`, [owner, fields.seriesId]);
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
      const { rows: [row] } = await db.query<EditRow>(`INSERT INTO ${cd}.cd_edits(owner_id,series_id,title,timeline)
        VALUES($1,$2,$3,$4) RETURNING ${columns},timeline`, [owner, seriesId, fields.title, timeline]);
      const refs = await this.refs(db, owner, row.id, timeline);
      await this.rememberLastEdit(db, owner, row.id);
      return this.detail(row, refs);
    });
  }

  private async save(db: ComicQuery, owner: string, row: EditRow, title: string, timeline: ComicTimeline) {
    const sources = await this.refs(db, owner, row.id, timeline);
    const { rows: [next] } = await db.query<EditRow>(`UPDATE ${cd}.cd_edits SET title=$3,timeline=$4,revision=revision+1,updated_at=clock_timestamp()
      WHERE owner_id=$1 AND id=$2 RETURNING ${columns},timeline`, [owner, row.id, title, timeline]);
    await this.rememberLastEdit(db, owner, row.id);
    return this.detail(next, sources);
  }

  update(owner: string, id: string, fields: ComicEditUpdate) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id, true);
      if (row.revision !== fields.expectedRevision) throw new ComicEditConflict(row.revision);
      return this.save(db, owner, row, fields.title, fields.timeline);
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
      const existingOverlays = row.timeline.voice.length + row.timeline.sfx.length + row.timeline.music.length + row.timeline.subtitles.length;
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
        `SELECT adopted_video_take_id AS "takeId" FROM ${cd}.cd_clips WHERE id=$1 AND series_id=$2 FOR SHARE`, [source.clipId, source.seriesId]);
      if (clip?.takeId !== fields.takeId) throw new ComicLibraryError("EDIT_ADOPTION_CHANGED", 409);
      const [adopted] = await this.sources(db, owner, [fields.takeId]);
      if (!adopted) throw new ComicLibraryError("EDIT_SOURCE_UNAVAILABLE", 404);
      const outMs = fields.outMs ?? item.outMs;
      if (outMs > adopted.durationMs || outMs <= item.inMs) throw new ComicLibraryError("EDIT_TRIM_REQUIRED", 409);
      const attached = [...row.timeline.voice, ...row.timeline.sfx, ...row.timeline.music, ...row.timeline.subtitles];
      if (attached.some(entry => entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id &&
        entry.anchor.offsetMs + entry.durationMs > outMs - item.inMs)) throw new ComicLibraryError("EDIT_ATTACHED_OVERFLOW", 409);
      const timeline = { ...row.timeline, video: row.timeline.video.map(current =>
        current.id === item.id ? { ...item, takeId: adopted.takeId, sourceDurationMs: adopted.durationMs, outMs } : current) };
      if (!comicEditUpdateSchema.safeParse({ title: row.title, expectedRevision: row.revision, timeline }).success) {
        throw new ComicLibraryError("EDIT_TRIM_REQUIRED", 409);
      }
      return this.save(db, owner, row, row.title, timeline);
    });
  }

  remove(owner: string, id: string, revision: number) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.read(db, owner, id, true);
      if (row.revision !== revision) throw new ComicEditConflict(row.revision);
      await db.query(`DELETE FROM ${cd}.cd_edits WHERE owner_id=$1 AND id=$2`, [owner, id]);
    });
  }
}
