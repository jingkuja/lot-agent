import {
  comicCastAsset, comicCastSnapshotSchema, comicDramaClipDraftSchema, fitComicActor, type ComicCastChange,
  type ComicCastSnapshot, type ComicClipCasting, type ComicSeriesCast,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing, type ComicQuery } from "./library-db.js";

const currentSnapshot = `jsonb_build_object(
  'schemaVersion',1,'characterId',c.id,'name',c.name,'aliases',c.aliases,'age',c.age,'personality',c.personality,
  'appearance',c.appearance,'roleKey',c.role_key,'outfitId',o.id,'outfitName',o.name,
  'assets',coalesce((
    SELECT jsonb_agg(asset ORDER BY kind,key) FROM (
      SELECT DISTINCT ON (a.kind,a.key) a.kind,a.key,
        jsonb_build_object('kind',a.kind,'key',a.key,'version',a.version,'media',jsonb_build_object(
          'id',m.id,'mime',m.mime,'sizeBytes',m.size_bytes,'width',m.width,'height',m.height,
          'durationMs',m.duration_ms,'hasThumbnail',m.thumbnail_key IS NOT NULL
        )) AS asset
      FROM lot_comic_drama.cd_character_assets a JOIN lot_comic_drama.cd_media m ON m.owner_id=a.owner_id AND m.id=a.media_id
      WHERE a.owner_id=c.owner_id AND a.character_id=c.id AND a.deleted_at IS NULL AND (a.outfit_id=o.id OR a.kind='expression')
      ORDER BY a.kind,a.key,a.version DESC
    ) latest
  ), '[]'::jsonb)
)`;

export async function readSeriesCast(db: ComicQuery, seriesId: string): Promise<ComicSeriesCast[]> {
  const { rows } = await db.query<ComicSeriesCast>(`SELECT s.snapshot,(c.archived_at IS NOT NULL) AS archived,
    (c.archived_at IS NULL AND s.snapshot IS DISTINCT FROM ${currentSnapshot}) AS "hasUpdates",
    d.id AS "originDramaId",d.title AS "originDramaTitle"
    FROM lot_comic_drama.cd_series_cast s
    JOIN lot_comic_drama.cd_characters c ON c.owner_id=s.owner_id AND c.id=s.character_id
    JOIN lot_comic_drama.cd_character_outfits o ON o.owner_id=s.owner_id AND o.character_id=s.character_id AND o.id=s.outfit_id
    LEFT JOIN lot_comic_drama.cd_dramas d ON d.owner_id=c.owner_id AND d.id=c.drama_id AND d.deleted_at IS NULL
    WHERE s.series_id=$1 ORDER BY s.snapshot->>'name',s.character_id`, [seriesId]);
  return rows.map(row => ({ ...row, snapshot: comicCastSnapshotSchema.parse(row.snapshot) }));
}

export async function readDramaCast(db: ComicQuery, dramaId: string): Promise<ComicSeriesCast[]> {
  const { rows } = await db.query<ComicSeriesCast>(`SELECT s.snapshot,(c.archived_at IS NOT NULL) AS archived,
    (c.archived_at IS NULL AND s.snapshot IS DISTINCT FROM ${currentSnapshot}) AS "hasUpdates",
    d.id AS "originDramaId",d.title AS "originDramaTitle"
    FROM lot_comic_drama.cd_drama_cast s
    JOIN lot_comic_drama.cd_characters c ON c.owner_id=s.owner_id AND c.id=s.character_id
    JOIN lot_comic_drama.cd_character_outfits o ON o.owner_id=s.owner_id AND o.character_id=s.character_id AND o.id=s.outfit_id
    LEFT JOIN lot_comic_drama.cd_dramas d ON d.owner_id=c.owner_id AND d.id=c.drama_id AND d.deleted_at IS NULL
    WHERE s.drama_id=$1 ORDER BY s.snapshot->>'name',s.character_id`, [dramaId]);
  return rows.map(row => ({ ...row, snapshot: comicCastSnapshotSchema.parse(row.snapshot) }));
}

export async function syncDramaCastToSeries(db: ComicQuery, owner: string, dramaId: string, seriesId: string): Promise<number> {
  const result = await db.query(
    `INSERT INTO lot_comic_drama.cd_series_cast(owner_id,series_id,character_id,outfit_id,snapshot)
     SELECT owner_id,$1,character_id,outfit_id,snapshot
     FROM lot_comic_drama.cd_drama_cast
     WHERE owner_id=$2 AND drama_id=$3
     ON CONFLICT (series_id, character_id) DO NOTHING`,
    [seriesId, owner, dramaId],
  );
  return result.rowCount ?? 0;
}

async function capture(db: ComicQuery, owner: string, characterId: string, outfitId: string): Promise<ComicCastSnapshot> {
  const character = await db.query(`SELECT id FROM lot_comic_drama.cd_characters
    WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [owner, characterId]);
  if (!character.rowCount) libraryMissing();
  const { rows } = await db.query(`SELECT ${currentSnapshot} AS snapshot
    FROM lot_comic_drama.cd_characters c JOIN lot_comic_drama.cd_character_outfits o ON o.owner_id=c.owner_id AND o.character_id=c.id
    WHERE c.owner_id=$1 AND c.id=$2 AND o.id=$3`, [owner, characterId, outfitId]);
  if (!rows[0]) libraryMissing();
  return comicCastSnapshotSchema.parse(rows[0].snapshot);
}

async function adjustClipCast(db: ComicQuery, seriesId: string, characterId: string, replacement?: ComicCastSnapshot) {
  const { rows } = await db.query<{ id: string; draft: unknown }>(`SELECT id,draft FROM lot_comic_drama.cd_clips
    WHERE series_id=$1 AND draft->'cast' @> jsonb_build_array(jsonb_build_object('characterId',$2::text))`, [seriesId, characterId]);
  for (const row of rows) {
    const draft = comicDramaClipDraftSchema.parse(row.draft);
    const cast = draft.cast?.flatMap(actor => {
      if (actor.characterId !== characterId) return [actor];
      if (!replacement) return [];
      return [fitComicActor(actor, replacement)];
    });
    if (JSON.stringify(cast) === JSON.stringify(draft.cast)) continue;
    await db.query(`UPDATE lot_comic_drama.cd_clips SET draft=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, { ...draft, cast }]);
  }
}

/** Caller holds the series row lock and checks its revision before this operation. */
export async function editSeriesCast(db: ComicQuery, owner: string, seriesId: string, change: ComicCastChange) {
  const { characterId, action } = change;
  const { rows } = await db.query<{ outfitId: string }>(`SELECT outfit_id AS "outfitId" FROM lot_comic_drama.cd_series_cast
    WHERE series_id=$1 AND owner_id=$2 AND character_id=$3`, [seriesId, owner, characterId]);
  const existing = rows[0];
  if (action === "add" && existing) throw new ComicLibraryError("ALREADY_CAST", 409);
  if (action !== "add" && !existing) libraryMissing();
  if (action === "remove") {
    await adjustClipCast(db, seriesId, characterId);
    await db.query(`DELETE FROM lot_comic_drama.cd_series_cast WHERE series_id=$1 AND character_id=$2 AND owner_id=$3`, [seriesId, characterId, owner]);
    return;
  }
  if (action === "outfit" && change.outfitId === existing.outfitId) return;
  const outfitId = "outfitId" in change ? change.outfitId : existing.outfitId;
  const snapshot = await capture(db, owner, characterId, outfitId);
  await db.query(`INSERT INTO lot_comic_drama.cd_series_cast(owner_id,series_id,character_id,outfit_id,snapshot)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(series_id,character_id) DO UPDATE SET outfit_id=excluded.outfit_id,snapshot=excluded.snapshot`,
    [owner, seriesId, characterId, outfitId, snapshot]);
  if (action === "outfit") await adjustClipCast(db, seriesId, characterId, snapshot);
}

/** Caller holds the drama row lock and checks its revision before this operation. */
export async function editDramaCast(db: ComicQuery, owner: string, dramaId: string, change: ComicCastChange) {
  const { characterId, action } = change;
  const { rows } = await db.query<{ outfitId: string }>(`SELECT outfit_id AS "outfitId" FROM lot_comic_drama.cd_drama_cast
    WHERE drama_id=$1 AND owner_id=$2 AND character_id=$3`, [dramaId, owner, characterId]);
  const existing = rows[0];
  if (action === "add" && existing) throw new ComicLibraryError("ALREADY_CAST", 409);
  if (action !== "add" && !existing) libraryMissing();
  if (action === "remove") {
    await db.query(
      `DELETE FROM lot_comic_drama.cd_drama_cast WHERE drama_id=$1 AND character_id=$2 AND owner_id=$3`,
      [dramaId, characterId, owner],
    );
    return;
  }
  if (action === "outfit" && change.outfitId === existing.outfitId) return;
  const outfitId = "outfitId" in change ? change.outfitId : existing.outfitId;
  const snapshot = await capture(db, owner, characterId, outfitId);
  await db.query(
    `INSERT INTO lot_comic_drama.cd_drama_cast(owner_id,drama_id,character_id,outfit_id,snapshot)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(drama_id,character_id) DO UPDATE SET outfit_id=excluded.outfit_id,snapshot=excluded.snapshot`,
    [owner, dramaId, characterId, outfitId, snapshot],
  );
}

export async function requireClipCast(db: ComicQuery, seriesId: string, cast: ComicClipCasting | undefined) {
  if (!cast?.length) return;
  const { rows } = await db.query<{ snapshot: ComicCastSnapshot }>(`SELECT snapshot FROM lot_comic_drama.cd_series_cast
    WHERE series_id=$1 AND character_id=ANY($2::uuid[])`, [seriesId, cast.map(actor => actor.characterId)]);
  const snapshots = new Map(rows.map(({ snapshot }) => [snapshot.characterId, snapshot]));
  for (const actor of cast) {
    const snapshot = snapshots.get(actor.characterId);
    if (!snapshot || (actor.slotKey && !comicCastAsset(snapshot, "slot", actor.slotKey)) ||
      (actor.expressionKey && !comicCastAsset(snapshot, "expression", actor.expressionKey))) {
      throw new ComicLibraryError("INVALID_CAST_REFERENCE", 400);
    }
  }
}
