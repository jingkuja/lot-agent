import type { Pool } from "pg";
import type {
  ComicCharacter, ComicCharacterAsset, ComicCharacterDetail, ComicCharacterInput, ComicCharacterSearch, ComicCharacterUpload,
  ComicLibraryPage, ComicLibraryRepository, ComicMaterial, ComicMaterialInput, ComicMaterialSearch, ComicMaterialUpdate,
  ComicMediaVersion, ComicOutfit, StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { requireComicChoice } from "./dictionary.js";
import { bindComicCharacterDesignVoice, readComicCharacterDesignVoice } from "./character-voice-store.js";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";

const tables = "lot_comic_drama";
const pageSize = 24;
const characterColumns = `c.id,c.name,c.aliases,c.tags,c.role_key AS "roleKey",d.id AS "dramaId",d.title AS "dramaTitle",
  c.age,c.gender,c.personality,c.appearance,(c.archived_at IS NOT NULL) AS archived`;
const materialColumns = `m.id,kind,name,category_key AS "categoryKey",tags,(archived_at IS NOT NULL) AS archived`;
const mediaValue = `jsonb_build_object('id',f.id,'mime',f.mime,'sizeBytes',f.size_bytes,'width',f.width,'height',f.height,
  'durationMs',f.duration_ms,'hasThumbnail',f.thumbnail_key IS NOT NULL)`;

const mediaColumns = `id,owner_id AS owner,storage_key AS "storageKey",thumbnail_key AS "thumbnailKey",mime,size_bytes AS "sizeBytes",
  width,height,duration_ms AS "durationMs",(thumbnail_key IS NOT NULL) AS "hasThumbnail"`;

export async function insertComicMedia(db: ComicQuery, media: StoredComicMedia) {
  const { id, owner, storageKey, thumbnailKey, mime, sizeBytes, width, height, durationMs } = media;
  await db.query(`INSERT INTO ${tables}.cd_media (id,owner_id,storage_key,thumbnail_key,mime,size_bytes,width,height,duration_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, owner, storageKey, thumbnailKey, mime, sizeBytes, width, height, durationMs]);
}

/** Callers hold the character row lock while allocating the next asset version. */
export async function insertComicCharacterVersion(
  db: ComicQuery, owner: string, id: string, input: ComicCharacterUpload, mediaId: string,
) {
  const outfit = input.kind === "slot" ? input.outfitId : null;
  const { rows } = await db.query<{ version: number }>(`INSERT INTO ${tables}.cd_character_assets
    (owner_id,character_id,outfit_id,kind,key,version,media_id)
    SELECT $1,$2,$3,$4,$5,coalesce(max(version),0)+1,$6 FROM ${tables}.cd_character_assets
    WHERE owner_id=$1 AND character_id=$2 AND outfit_id IS NOT DISTINCT FROM $3::uuid AND kind=$4 AND key=$5 RETURNING version`,
  [owner, id, outfit, input.kind, input.key, mediaId]);
  await db.query(`UPDATE ${tables}.cd_characters SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2`, [owner, id]);
  return rows[0].version;
}

export async function insertComicMaterialVersion(db: ComicQuery, owner: string, id: string, mediaId: string) {
  const { rows } = await db.query<{ version: number }>(`INSERT INTO ${tables}.cd_material_versions(owner_id,material_id,version,media_id)
    SELECT $1,$2,coalesce(max(version),0)+1,$3 FROM ${tables}.cd_material_versions WHERE owner_id=$1 AND material_id=$2 RETURNING version`,
  [owner, id, mediaId]);
  await db.query(`UPDATE ${tables}.cd_materials SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2`, [owner, id]);
  return rows[0].version;
}

function page<T>(rows: T[]): ComicLibraryPage<T> {
  return { entries: rows.slice(0, pageSize), more: rows.length > pageSize };
}

export class PgComicLibrary implements ComicLibraryRepository {
  constructor(private readonly pool: Pool) {}

  async media(owner: string, id: string) {
    const { rows } = await this.pool.query<StoredComicMedia>(`SELECT ${mediaColumns} FROM ${tables}.cd_media WHERE owner_id=$1 AND id=$2`, [owner, id]);
    return rows[0];
  }

  async file(key: string) {
    const { rows } = await this.pool.query<{ id: string; owner: string }>(
      `SELECT id, owner_id AS owner FROM ${tables}.cd_media WHERE storage_key=$1 OR thumbnail_key=$1`, [key],
    );
    return rows[0];
  }

  private async verifyCharacterDrama(db: ComicQuery, owner: string, dramaId: string | null | undefined) {
    if (!dramaId) return;
    const { rowCount } = await db.query(
      `SELECT 1 FROM ${tables}.cd_dramas WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [owner, dramaId],
    );
    if (!rowCount) throw new ComicLibraryError("INVALID_INPUT", 400);
  }

  async listCharacters(owner: string, input: ComicCharacterSearch) {
    const dramaFilter = input.dramaId === "unassigned"
      ? "AND d.id IS NULL"
      : input.dramaId
        ? "AND d.id=$6::uuid"
        : "";
    const params: unknown[] = [
      owner,
      input.archived === "true",
      input.query ?? "",
      pageSize + 1,
      (input.page - 1) * pageSize,
      ...(input.dramaId && input.dramaId !== "unassigned" ? [input.dramaId] : []),
    ];
    const { rows } = await this.pool.query<ComicCharacter>(
      `SELECT ${characterColumns},hero.cover
       FROM ${tables}.cd_characters c
       LEFT JOIN ${tables}.cd_dramas d ON d.owner_id=c.owner_id AND d.id=c.drama_id AND d.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT ${mediaValue} AS cover FROM ${tables}.cd_character_assets a JOIN ${tables}.cd_media f ON f.id=a.media_id
         WHERE a.character_id=c.id AND a.deleted_at IS NULL ORDER BY (a.kind='slot' AND a.key='front') DESC,f.created_at DESC,f.id DESC LIMIT 1
       ) hero ON true
       WHERE c.owner_id=$1 AND (c.archived_at IS NOT NULL)=$2
         AND strpos(lower(c.name || ' ' || array_to_string(c.aliases,' ') || ' ' || array_to_string(c.tags,' ')
           || ' ' || coalesce(d.title,'')),lower($3))>0
         ${dramaFilter}
       ORDER BY c.updated_at DESC,c.id LIMIT $4 OFFSET $5`,
      params,
    );
    return page(rows);
  }

  private async character(db: ComicQuery, owner: string, id: string, write = false) {
    const { rows } = await db.query<Omit<ComicCharacter, "cover">>(
      `SELECT ${characterColumns} FROM ${tables}.cd_characters c
       LEFT JOIN ${tables}.cd_dramas d ON d.owner_id=c.owner_id AND d.id=c.drama_id AND d.deleted_at IS NULL
       WHERE c.owner_id=$1 AND c.id=$2 ${write ? "AND c.archived_at IS NULL FOR UPDATE OF c" : ""}`,
      [owner, id],
    );
    if (!rows[0]) libraryMissing();
    return rows[0];
  }

  async getCharacter(owner: string, id: string, db: ComicQuery = this.pool): Promise<ComicCharacterDetail> {
    const character = await this.character(db, owner, id);
    const outfits = await db.query<ComicOutfit>(`SELECT id,name,sort FROM ${tables}.cd_character_outfits
      WHERE owner_id=$1 AND character_id=$2 ORDER BY sort,name,id`, [owner, id]);
    const { rows: assets } = await db.query<ComicCharacterAsset>(`SELECT DISTINCT ON (a.kind,a.outfit_id,a.key)
      a.kind,a.key,a.outfit_id AS "outfitId",a.version,${mediaValue} AS media FROM ${tables}.cd_character_assets a
      JOIN ${tables}.cd_media f ON f.id=a.media_id WHERE a.owner_id=$1 AND a.character_id=$2 AND a.deleted_at IS NULL
      ORDER BY a.kind,a.outfit_id,a.key,a.version DESC`, [owner, id]);
    const designVoice = await readComicCharacterDesignVoice(db, owner, id);
    const cover = (assets.find(asset => asset.kind === "slot" && asset.key === "front") ?? assets[0])?.media ?? null;
    return { ...character, outfits: outfits.rows, assets, cover, designVoice };
  }

  async createCharacter(owner: string, input: ComicCharacterInput) {
    return libraryTransaction(this.pool, async db => {
      await requireComicChoice(db, owner, "role", input.roleKey);
      await this.verifyCharacterDrama(db, owner, input.dramaId);
      const { name, aliases, tags, roleKey, age, personality, appearance, gender, designVoiceId } = input;
      const { rows: [{ id }] } = await db.query<{ id: string }>(`INSERT INTO ${tables}.cd_characters
        (owner_id,name,aliases,tags,role_key,drama_id,age,personality,appearance,gender) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [owner, name, aliases, tags, roleKey, input.dramaId ?? null, age, personality, appearance, gender ?? null]);
      if (designVoiceId) await bindComicCharacterDesignVoice(db, owner, id, designVoiceId);
      return id;
    });
  }

  async editCharacter(owner: string, id: string, input: ComicCharacterInput) {
    await libraryTransaction(this.pool, async db => {
      const current = await this.character(db, owner, id, true);
      if (current.roleKey !== input.roleKey) await requireComicChoice(db, owner, "role", input.roleKey);
      const nextDramaId = input.dramaId === undefined ? (current.dramaId ?? null) : input.dramaId;
      if (nextDramaId !== (current.dramaId ?? null)) {
        await this.verifyCharacterDrama(db, owner, nextDramaId);
      }
      const { name, aliases, tags, roleKey, age, personality, appearance, gender, designVoiceId } = input;
      const nextGender = gender === undefined ? current.gender ?? null : gender;
      await db.query(`UPDATE ${tables}.cd_characters SET name=$2,aliases=$3,tags=$4,role_key=$5,drama_id=$6,age=$7,personality=$8,appearance=$9,
        gender=$10,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$11`,
      [id, name, aliases, tags, roleKey, nextDramaId, age, personality, appearance, nextGender, owner]);
      if (designVoiceId) await bindComicCharacterDesignVoice(db, owner, id, designVoiceId);
    });
  }

  async archiveCharacter(owner: string, id: string) {
    const result = await this.pool.query(`UPDATE ${tables}.cd_characters SET archived_at=now(),updated_at=clock_timestamp()
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL`, [owner, id]);
    if (!result.rowCount) libraryMissing();
  }

  addOutfit(owner: string, id: string, name: string): Promise<ComicOutfit> {
    return libraryTransaction(this.pool, async db => {
      await this.character(db, owner, id, true);
      const { rows } = await db.query<ComicOutfit>(`INSERT INTO ${tables}.cd_character_outfits(owner_id,character_id,name,sort)
        SELECT $1,$2,$3,coalesce(max(sort)+1,0) FROM ${tables}.cd_character_outfits WHERE owner_id=$1 AND character_id=$2
        RETURNING id,name,sort`, [owner, id, name]);
      return rows[0];
    });
  }

  renameOutfit(owner: string, characterId: string, outfitId: string, name: string): Promise<ComicOutfit> {
    return libraryTransaction(this.pool, async db => {
      await this.character(db, owner, characterId, true);
      const { rows } = await db.query<ComicOutfit>(`UPDATE ${tables}.cd_character_outfits SET name=$4
        WHERE owner_id=$1 AND character_id=$2 AND id=$3 RETURNING id,name,sort`, [owner, characterId, outfitId, name]);
      if (!rows[0]) libraryMissing();
      await db.query(`UPDATE ${tables}.cd_characters SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2`, [owner, characterId]);
      return rows[0];
    });
  }

  reorderOutfits(owner: string, characterId: string, outfitIds: string[]): Promise<ComicOutfit[]> {
    return libraryTransaction(this.pool, async db => {
      await this.character(db, owner, characterId, true);
      const { rows: existing } = await db.query<{ id: string }>(
        `SELECT id FROM ${tables}.cd_character_outfits WHERE owner_id=$1 AND character_id=$2`, [owner, characterId],
      );
      const provided = new Set(outfitIds);
      if (existing.length !== outfitIds.length || existing.some(row => !provided.has(row.id))) {
        throw new ComicLibraryError("INVALID_INPUT", 400);
      }
      await db.query(`UPDATE ${tables}.cd_character_outfits o SET sort=src.ord
        FROM unnest($3::uuid[]) WITH ORDINALITY AS src(outfit_id, ord)
        WHERE o.owner_id=$1 AND o.character_id=$2 AND o.id=src.outfit_id`, [owner, characterId, outfitIds]);
      const { rows } = await db.query<ComicOutfit>(
        `SELECT id,name,sort FROM ${tables}.cd_character_outfits WHERE owner_id=$1 AND character_id=$2 ORDER BY sort,name,id`,
        [owner, characterId],
      );
      return rows;
    });
  }

  deleteOutfit(owner: string, characterId: string, outfitId: string): Promise<void> {
    return libraryTransaction(this.pool, async db => {
      await this.character(db, owner, characterId, true);
      const inUse = await db.query(
        `SELECT 1 FROM ${tables}.cd_series_cast sc JOIN ${tables}.cd_series s ON s.id=sc.series_id
         WHERE sc.owner_id=$1 AND sc.character_id=$2 AND sc.outfit_id=$3 AND s.deleted_at IS NULL
         UNION ALL
         SELECT 1 FROM ${tables}.cd_drama_cast dc JOIN ${tables}.cd_dramas d ON d.id=dc.drama_id
         WHERE dc.owner_id=$1 AND dc.character_id=$2 AND dc.outfit_id=$3 AND d.deleted_at IS NULL
         LIMIT 1`,
        [owner, characterId, outfitId],
      );
      if (inUse.rowCount) throw new ComicLibraryError("OUTFIT_IN_USE", 409);
      const result = await db.query(
        `DELETE FROM ${tables}.cd_character_outfits WHERE owner_id=$1 AND character_id=$2 AND id=$3`,
        [owner, characterId, outfitId],
      );
      if (!result.rowCount) libraryMissing();
      await db.query(`UPDATE ${tables}.cd_characters SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2`, [owner, characterId]);
    });
  }

  private async validateCharacterUpload(db: ComicQuery, owner: string, id: string, input: ComicCharacterUpload, lock = false) {
    const character = await this.character(db, owner, id, lock);
    if (character.archived) libraryMissing();
    if (input.kind === "slot") {
      const outfit = await db.query(`SELECT 1 FROM ${tables}.cd_character_outfits WHERE owner_id=$1 AND character_id=$2 AND id=$3`,
        [owner, id, input.outfitId]);
      if (!outfit.rowCount) libraryMissing();
    }
    await requireComicChoice(db, owner, input.kind, input.key);
  }

  validateCharacterAsset(owner: string, id: string, input: ComicCharacterUpload, db: ComicQuery = this.pool) {
    return this.validateCharacterUpload(db, owner, id, input);
  }

  addCharacterAsset(owner: string, id: string, input: ComicCharacterUpload, media: StoredComicMedia) {
    return libraryTransaction(this.pool, async db => {
      await this.validateCharacterUpload(db, owner, id, input, true);
      await insertComicMedia(db, media);
      return insertComicCharacterVersion(db, owner, id, input, media.id);
    });
  }

  deleteCharacterAsset(owner: string, id: string, input: ComicCharacterUpload): Promise<void> {
    return libraryTransaction(this.pool, async db => {
      await this.character(db, owner, id, true);
      const outfit = input.kind === "slot" ? input.outfitId : null;
      const result = await db.query(`UPDATE ${tables}.cd_character_assets SET deleted_at=now()
        WHERE owner_id=$1 AND character_id=$2 AND outfit_id IS NOT DISTINCT FROM $3::uuid
          AND kind=$4 AND key=$5 AND deleted_at IS NULL`,
      [owner, id, outfit, input.kind, input.key]);
      if (!result.rowCount) libraryMissing();
      await db.query(`UPDATE ${tables}.cd_characters SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2`, [owner, id]);
    });
  }

  async characterVersions(owner: string, id: string, input: ComicCharacterUpload): Promise<ComicMediaVersion[]> {
    await this.character(this.pool, owner, id);
    const { rows } = await this.pool.query<ComicMediaVersion>(`SELECT a.version,${mediaValue} AS media FROM ${tables}.cd_character_assets a
      JOIN ${tables}.cd_media f ON f.id=a.media_id WHERE a.owner_id=$1 AND a.character_id=$2 AND a.outfit_id IS NOT DISTINCT FROM $3::uuid
      AND a.kind=$4 AND a.key=$5 AND a.deleted_at IS NULL ORDER BY a.version DESC`,
    [owner, id, input.kind === "slot" ? input.outfitId : null, input.kind, input.key]);
    return rows;
  }

  async listMaterials(owner: string, input: ComicMaterialSearch) {
    const { rows } = await this.pool.query<ComicMaterial>(`SELECT ${materialColumns},v.version,${mediaValue} AS media
      FROM ${tables}.cd_materials m JOIN LATERAL (
        SELECT version,media_id FROM ${tables}.cd_material_versions WHERE material_id=m.id ORDER BY version DESC LIMIT 1
      ) v ON true JOIN ${tables}.cd_media f ON f.id=v.media_id WHERE m.owner_id=$1 AND (m.archived_at IS NOT NULL)=$2
      AND strpos(lower(m.name || ' ' || array_to_string(m.tags,' ')),lower($3))>0 AND ($4::text IS NULL OR m.kind=$4)
      AND ($7::text IS NULL OR split_part(f.mime,'/',1)=$7)
      ORDER BY m.updated_at DESC,m.id LIMIT $5 OFFSET $6`,
    [owner, input.archived === "true", input.query ?? "", input.kind ?? null, pageSize + 1, (input.page - 1) * pageSize, input.mime ?? null]);
    return page(rows);
  }

  async materialInput(owner: string, id: string, db: ComicQuery = this.pool, lock = false): Promise<ComicMaterialInput> {
    const { rows } = await db.query<ComicMaterialInput>(`SELECT kind,name,category_key AS "categoryKey",tags FROM ${tables}.cd_materials
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL ${lock ? "FOR UPDATE" : ""}`, [owner, id]);
    if (!rows[0]) libraryMissing();
    return rows[0];
  }

  async materialImageReference(owner: string, id: string) {
    const { rows } = await this.pool.query<StoredComicMedia & { version: number }>(`SELECT ${mediaColumns},coalesce((
      SELECT v.version FROM ${tables}.cd_material_versions v WHERE v.owner_id=$1 AND v.media_id=$2
    ),1) AS version FROM ${tables}.cd_media WHERE owner_id=$1 AND id=$2`, [owner, id]);
    return rows[0];
  }

  async addMaterial(owner: string, input: ComicMaterialInput, media: StoredComicMedia) {
    return libraryTransaction(this.pool, async db => {
      const { kind, name, categoryKey, tags } = input;
      await requireComicChoice(db, owner, kind, categoryKey);
      await insertComicMedia(db, media);
      const { rows } = await db.query<{ id: string }>(`INSERT INTO ${tables}.cd_materials(owner_id,kind,name,category_key,tags)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [owner, kind, name, categoryKey, tags]);
      const id = rows[0].id;
      await db.query(`INSERT INTO ${tables}.cd_material_versions(owner_id,material_id,version,media_id) VALUES($1,$2,1,$3)`, [owner, id, media.id]);
      return id;
    });
  }

  replaceMaterial(owner: string, id: string, media: StoredComicMedia) {
    return libraryTransaction(this.pool, async db => {
      await this.materialInput(owner, id, db, true);
      await insertComicMedia(db, media);
      const { rows } = await db.query<{ version: number }>(`INSERT INTO ${tables}.cd_material_versions(owner_id,material_id,version,media_id)
        SELECT $1,$2,max(version)+1,$3 FROM ${tables}.cd_material_versions WHERE material_id=$2 RETURNING version`, [owner, id, media.id]);
      await db.query(`UPDATE ${tables}.cd_materials SET updated_at=clock_timestamp() WHERE id=$1`, [id]);
      return rows[0].version;
    });
  }

  async materialVersions(owner: string, id: string): Promise<ComicMediaVersion[]> {
    const { rows } = await this.pool.query<ComicMediaVersion>(`SELECT v.version,${mediaValue} AS media FROM ${tables}.cd_material_versions v
      JOIN ${tables}.cd_media f ON f.id=v.media_id WHERE v.owner_id=$1 AND v.material_id=$2 ORDER BY v.version DESC`, [owner, id]);
    if (!rows.length) libraryMissing();
    return rows;
  }

  async addMaterialFromMedia(owner: string, input: ComicMaterialInput, mediaId: string) {
    return libraryTransaction(this.pool, async db => {
      const { kind, name, categoryKey, tags } = input;
      await requireComicChoice(db, owner, kind, categoryKey);
      const { rows: [media] } = await db.query<{ id: string; mime: string }>(
        `SELECT id, mime FROM ${tables}.cd_media WHERE owner_id=$1 AND id=$2`, [owner, mediaId],
      );
      if (!media) libraryMissing();
      const isImage = media.mime.startsWith("image/");
      const isAudio = media.mime.startsWith("audio/");
      if ((kind === "scene" || kind === "prop") && !isImage) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
      if ((kind === "sound" || kind === "music") && !isAudio) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
      if (kind === "other" && !isImage && !isAudio && media.mime !== "video/mp4" && media.mime !== "video/quicktime") {
        throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
      }
      const { rows } = await db.query<{ id: string }>(`INSERT INTO ${tables}.cd_materials(owner_id,kind,name,category_key,tags)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [owner, kind, name, categoryKey, tags]);
      const id = rows[0].id;
      await db.query(`INSERT INTO ${tables}.cd_material_versions(owner_id,material_id,version,media_id) VALUES($1,$2,1,$3)`, [owner, id, media.id]);
      return id;
    });
  }

  async editMaterial(owner: string, id: string, input: ComicMaterialUpdate) {
    await libraryTransaction(this.pool, async db => {
      const current = await this.materialInput(owner, id, db, true);
      if (current.categoryKey !== input.categoryKey) await requireComicChoice(db, owner, current.kind, input.categoryKey);
      await db.query(`UPDATE ${tables}.cd_materials SET name=$2,category_key=$3,tags=$4,updated_at=clock_timestamp()
        WHERE owner_id=$1 AND id=$5`, [owner, input.name, input.categoryKey, input.tags, id]);
    });
  }

  async archiveMaterial(owner: string, id: string) {
    const result = await this.pool.query(`UPDATE ${tables}.cd_materials SET archived_at=now(),updated_at=clock_timestamp()
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL`, [owner, id]);
    if (!result.rowCount) libraryMissing();
  }

  async unarchiveMaterial(owner: string, id: string) {
    const result = await this.pool.query(`UPDATE ${tables}.cd_materials SET archived_at=NULL,updated_at=clock_timestamp()
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NOT NULL`, [owner, id]);
    if (!result.rowCount) libraryMissing();
  }

  async deleteMaterial(owner: string, id: string) {
    await libraryTransaction(this.pool, async db => {
      const exists = await db.query(`SELECT 1 FROM ${tables}.cd_materials WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [owner, id]);
      if (!exists.rowCount) libraryMissing();
      const inUse = await db.query(
        `SELECT 1 FROM ${tables}.cd_material_versions v
         WHERE v.owner_id=$1 AND v.material_id=$2 AND (
           EXISTS (SELECT 1 FROM ${tables}.cd_edit_media em WHERE em.owner_id=$1 AND em.media_id=v.media_id)
           OR EXISTS (SELECT 1 FROM ${tables}.cd_style_presets sp WHERE sp.owner_id=$1 AND sp.media_id=v.media_id)
         ) LIMIT 1`,
        [owner, id],
      );
      if (inUse.rowCount) throw new ComicLibraryError("MATERIAL_IN_USE", 409);
      const generating = await db.query(`SELECT 1 FROM ${tables}.cd_generation_requests r
        JOIN ${tables}.cd_takes t ON (t.owner_id,t.request_id)=(r.owner_id,r.id)
        WHERE r.owner_id=$1 AND r.material_id=$2 AND t.status IN ('pending','running','recoverable','unknown') LIMIT 1`, [owner, id]);
      if (generating.rowCount) throw new ComicLibraryError("BUSY", 409);
      await db.query(`DELETE FROM ${tables}.cd_materials WHERE owner_id=$1 AND id=$2`, [owner, id]);
    });
  }
}
