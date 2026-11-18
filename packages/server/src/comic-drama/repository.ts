import type { Pool, PoolClient } from "pg";
import {
  comicDramaClipSchema, comicDramaIdSchema, comicDramaSeriesSchema, type ComicDramaClip, type ComicDramaClipDraft, type ComicDramaClipUpdate,
  type ComicDramaContent, type ComicDramaDetail, type ComicDramaListQuery, type ComicDramaListing, type ComicDramaReorder,
  type ComicDramaRepository, type ComicDramaSeries, type ComicDramaSeriesInput, type ComicDramaSeriesUpdate,
} from "@lot-agent/core/comic-drama";

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

export class PgComicDramaRepository implements ComicDramaRepository {
  constructor(private readonly pool: Pool) {}

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

  private async content(client: PoolClient, id: string, seriesRevision: number): Promise<ComicDramaContent> {
    const clips = await client.query(`SELECT ${clipFields} FROM lot_comic_drama.cd_clips WHERE series_id=$1 ORDER BY ordinal`, [id]);
    const script = await client.query("SELECT version, content FROM lot_comic_drama.cd_scripts WHERE series_id=$1 ORDER BY version DESC LIMIT 1", [id]);
    return { seriesRevision, clips: clips.rows.map(row => comicDramaClipSchema.parse(row)), script: script.rows[0] ?? null };
  }

  async list(owner: string, { query, archived, cursor }: ComicDramaListQuery): Promise<ComicDramaListing> {
    const [at, id] = cursor?.split(",") ?? [];
    if (cursor && (cursor.split(",").length !== 2 || !Number.isFinite(Date.parse(at)) || !comicDramaIdSchema.safeParse(id).success)) {
      throw new ComicDramaError("INVALID_CURSOR");
    }
    const { rows } = await this.pool.query<SeriesRow & { updatedAt: Date; clipCount: number }>(
      `SELECT ${seriesFields}, updated_at AS "updatedAt",
       (SELECT count(*)::int FROM lot_comic_drama.cd_clips WHERE series_id=series.id) AS "clipCount"
       FROM lot_comic_drama.cd_series AS series WHERE owner_id=$1 AND deleted_at IS NULL AND (archived_at IS NOT NULL)=$2
       AND (strpos(lower(title),lower($3))>0 OR strpos(lower(coalesce(series_group,'')),lower($3))>0 OR $3='')
       AND ($4::timestamptz IS NULL OR (updated_at,id)<($4::timestamptz,$5::uuid))
       ORDER BY updated_at DESC,id DESC LIMIT 25`, [owner, archived === "true", query ?? "", at ?? null, id ?? null],
    );
    const entries = rows.slice(0, 24).map(({ updatedAt, clipCount, ...row }) => ({
      ...asSeries(row), updatedAt: updatedAt.toISOString(), clipCount,
    }));
    const last = entries.at(-1);
    return { entries, nextCursor: rows.length > 24 && last ? `${last.updatedAt},${last.id}` : null };
  }

  get(owner: string, id: string): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id);
      const { clips, script } = await this.content(client, id, series.revision);
      return { series, clips, script };
    }, true);
  }

  async current(owner: string): Promise<string | null> {
    const { rows } = await this.pool.query("SELECT current_series_id FROM lot_comic_drama.cd_user_state WHERE owner_id=$1", [owner]);
    return rows[0]?.current_series_id ?? null;
  }

  private async setCurrent(client: PoolClient, owner: string, id: string) {
    await client.query(`INSERT INTO lot_comic_drama.cd_user_state(owner_id,current_series_id) VALUES ($1,$2)
      ON CONFLICT (owner_id) DO UPDATE SET current_series_id=excluded.current_series_id`, [owner, id]);
  }

  open(owner: string, id: string): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      const series = await this.series(client, owner, id, true);
      await this.setCurrent(client, owner, id);
      const { clips, script } = await this.content(client, id, series.revision);
      return { series, clips, script };
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
      const series = await this.insert(client, owner, fields);
      await this.setCurrent(client, owner, series.id);
      return { series, clips: [], script: null };
    });
  }

  derive(owner: string, id: string, sequel: boolean): Promise<ComicDramaDetail> {
    return this.transaction(async client => {
      const source = await this.series(client, owner, id, true);
      const seriesGroup = source.seriesGroup ?? source.title;
      const episodeNo = sequel ? Math.min((source.episodeNo ?? 1) + 1, 2_147_483_647) : source.episodeNo;
      const suffix = sequel ? ` #${episodeNo}` : " (copy)";
      const title = (sequel ? seriesGroup : source.title).slice(0, 120 - suffix.length).replace(/[\uD800-\uDBFF]$/u, "") + suffix;
      const series = await this.insert(client, owner, {
        ...source, title, episodeNo, seriesGroup: sequel ? seriesGroup : source.seriesGroup, logline: sequel ? "" : source.logline,
      }, sequel ? id : source.parentId);
      if (!sequel) {
        await client.query("INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft) SELECT $1,ordinal,draft FROM lot_comic_drama.cd_clips WHERE series_id=$2", [series.id, id]);
        await client.query(`INSERT INTO lot_comic_drama.cd_scripts(series_id,version,content,source)
          SELECT $1,1,content,source FROM lot_comic_drama.cd_scripts WHERE series_id=$2 ORDER BY version DESC LIMIT 1`, [series.id, id]);
      }
      await this.setCurrent(client, owner, series.id);
      const { clips, script } = await this.content(client, series.id, series.revision);
      return { series, clips, script };
    });
  }

  update(owner: string, id: string, fields: ComicDramaSeriesUpdate): Promise<ComicDramaSeries> {
    return this.transaction(async client => {
      const current = await this.series(client, owner, id, true);
      requireRevision(current.revision, fields.expectedRevision);
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

  saveScript(owner: string, id: string, expected: number, content: string) {
    return this.editContent(owner, id, expected, client => client.query(`INSERT INTO lot_comic_drama.cd_scripts(series_id,version,content,source)
      SELECT $1,coalesce(max(version),0)+1,$2,'user' FROM lot_comic_drama.cd_scripts WHERE series_id=$1`, [id, content]));
  }

  addClip(owner: string, id: string, expected: number) {
    const draft: ComicDramaClipDraft = { schemaVersion: 1, durationMs: 6000, scene: "", shots: [], lines: [] };
    return this.editContent(owner, id, expected, client => client.query(`INSERT INTO lot_comic_drama.cd_clips(series_id,ordinal,draft)
      SELECT $1,coalesce(max(ordinal),0)+1,$2 FROM lot_comic_drama.cd_clips WHERE series_id=$1`, [id, draft]));
  }

  private async clip(client: PoolClient, id: string, clipId: string): Promise<ComicDramaClip> {
    const { rows } = await client.query(`SELECT ${clipFields} FROM lot_comic_drama.cd_clips WHERE series_id=$1 AND id=$2`, [id, clipId]);
    if (!rows[0]) throw new ComicDramaError("NOT_FOUND");
    return comicDramaClipSchema.parse(rows[0]);
  }

  saveClip(owner: string, id: string, clipId: string, { expectedRevision, draft }: ComicDramaClipUpdate) {
    return this.transaction(async client => {
      await this.series(client, owner, id, true);
      requireRevision((await this.clip(client, id, clipId)).revision, expectedRevision);
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
