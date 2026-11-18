import type { Pool } from "pg";
import type {
  ComicCharacter, ComicCharacterAsset, ComicCharacterDetail, ComicCharacterInput, ComicCharacterUpload, ComicLibraryPage, ComicLibrarySearch,
  ComicLibraryRepository, ComicMaterial, ComicMaterialInput, ComicMaterialSearch, ComicMediaVersion, ComicOutfit, StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { requireComicChoice } from "./dictionary.js";
import { libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";

const tables = "lot_comic_drama";
const pageSize = 24;
const characterColumns = `c.id,name,aliases,tags,role_key AS "roleKey",age,personality,appearance,(archived_at IS NOT NULL) AS archived`;
const materialColumns = `m.id,kind,name,category_key AS "categoryKey",tags,(archived_at IS NOT NULL) AS archived`;
const mediaValue = `jsonb_build_object('id',f.id,'mime',f.mime,'sizeBytes',f.size_bytes,'width',f.width,'height',f.height,
  'durationMs',f.duration_ms,'hasThumbnail',f.thumbnail_key IS NOT NULL)`;

const mediaColumns = `id,owner_id AS owner,storage_key AS "storageKey",thumbnail_key AS "thumbnailKey",mime,size_bytes AS "sizeBytes",
  width,height,duration_ms AS "durationMs",(thumbnail_key IS NOT NULL) AS "hasThumbnail"`;

async function insertMedia(db: ComicQuery, media: StoredComicMedia) {
  const { id, owner, storageKey, thumbnailKey, mime, sizeBytes, width, height, durationMs } = media;
  await db.query(`INSERT INTO ${tables}.cd_media (id,owner_id,storage_key,thumbnail_key,mime,size_bytes,width,height,duration_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, owner, storageKey, thumbnailKey, mime, sizeBytes, width, height, durationMs]);
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

  async listCharacters(owner: string, input: ComicLibrarySearch) {
    const { rows } = await this.pool.query<ComicCharacter>(`SELECT ${characterColumns},hero.cover
      FROM ${tables}.cd_characters c LEFT JOIN LATERAL (
        SELECT ${mediaValue} AS cover FROM ${tables}.cd_character_assets a JOIN ${tables}.cd_media f ON f.id=a.media_id
        WHERE a.character_id=c.id ORDER BY (a.kind='slot' AND a.key='front') DESC,f.created_at DESC,f.id DESC LIMIT 1
      ) hero ON true
      WHERE c.owner_id=$1 AND (c.archived_at IS NOT NULL)=$2
        AND strpos(lower(c.name || ' ' || array_to_string(c.aliases,' ') || ' ' || array_to_string(c.tags,' ')),lower($3))>0
      ORDER BY updated_at DESC,c.id LIMIT $4 OFFSET $5`, [owner, input.archived === "true", input.query ?? "", pageSize + 1, (input.page - 1) * pageSize]);
    return page(rows);
  }

  private async character(db: ComicQuery, owner: string, id: string, write = false) {
    const { rows } = await db.query<Omit<ComicCharacter, "cover">>(`SELECT ${characterColumns} FROM ${tables}.cd_characters c
      WHERE owner_id=$1 AND id=$2 ${write ? "AND archived_at IS NULL FOR UPDATE" : ""}`, [owner, id]);
    if (!rows[0]) libraryMissing();
    return rows[0];
  }

  async getCharacter(owner: string, id: string): Promise<ComicCharacterDetail> {
    const character = await this.character(this.pool, owner, id);
    const outfits = await this.pool.query<ComicOutfit>(`SELECT id,name FROM ${tables}.cd_character_outfits
      WHERE owner_id=$1 AND character_id=$2 ORDER BY name,id`, [owner, id]);
    const { rows: assets } = await this.pool.query<ComicCharacterAsset>(`SELECT DISTINCT ON (a.kind,a.outfit_id,a.key)
      a.kind,a.key,a.outfit_id AS "outfitId",a.version,${mediaValue} AS media FROM ${tables}.cd_character_assets a
      JOIN ${tables}.cd_media f ON f.id=a.media_id WHERE a.owner_id=$1 AND a.character_id=$2
      ORDER BY a.kind,a.outfit_id,a.key,a.version DESC`, [owner, id]);
    return { ...character, outfits: outfits.rows, assets, cover: (assets.find(asset => asset.kind === "slot" && asset.key === "front") ?? assets[0])?.media ?? null };
  }

  async createCharacter(owner: string, input: ComicCharacterInput) {
    return libraryTransaction(this.pool, async db => {
      await requireComicChoice(db, owner, "role", input.roleKey);
      const { name, aliases, tags, roleKey, age, personality, appearance } = input;
      const { rows } = await db.query<{ id: string }>(`INSERT INTO ${tables}.cd_characters
        (owner_id,name,aliases,tags,role_key,age,personality,appearance) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [owner, name, aliases, tags, roleKey, age, personality, appearance]);
      return rows[0].id;
    });
  }

  async editCharacter(owner: string, id: string, input: ComicCharacterInput) {
    await libraryTransaction(this.pool, async db => {
      const current = await this.character(db, owner, id, true);
      if (current.roleKey !== input.roleKey) await requireComicChoice(db, owner, "role", input.roleKey);
      const { name, aliases, tags, roleKey, age, personality, appearance } = input;
      await db.query(`UPDATE ${tables}.cd_characters SET name=$2,aliases=$3,tags=$4,role_key=$5,age=$6,personality=$7,appearance=$8,
        updated_at=clock_timestamp() WHERE id=$1`, [id, name, aliases, tags, roleKey, age, personality, appearance]);
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
      const { rows } = await db.query<ComicOutfit>(`INSERT INTO ${tables}.cd_character_outfits(owner_id,character_id,name)
        VALUES($1,$2,$3) RETURNING id,name`, [owner, id, name]);
      return rows[0];
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

  validateCharacterAsset(owner: string, id: string, input: ComicCharacterUpload) {
    return this.validateCharacterUpload(this.pool, owner, id, input);
  }

  addCharacterAsset(owner: string, id: string, input: ComicCharacterUpload, media: StoredComicMedia) {
    return libraryTransaction(this.pool, async db => {
      await this.validateCharacterUpload(db, owner, id, input, true);
      const outfit = input.kind === "slot" ? input.outfitId : null;
      await insertMedia(db, media);
      const { rows } = await db.query<{ version: number }>(`INSERT INTO ${tables}.cd_character_assets
        (owner_id,character_id,outfit_id,kind,key,version,media_id)
        SELECT $1,$2,$3,$4,$5,coalesce(max(version),0)+1,$6 FROM ${tables}.cd_character_assets
        WHERE character_id=$2 AND outfit_id IS NOT DISTINCT FROM $3::uuid AND kind=$4 AND key=$5 RETURNING version`,
        [owner, id, outfit, input.kind, input.key, media.id]);
      await db.query(`UPDATE ${tables}.cd_characters SET updated_at=clock_timestamp() WHERE id=$1`, [id]);
      return rows[0].version;
    });
  }

  async characterVersions(owner: string, id: string, input: ComicCharacterUpload): Promise<ComicMediaVersion[]> {
    await this.character(this.pool, owner, id);
    const { rows } = await this.pool.query<ComicMediaVersion>(`SELECT a.version,${mediaValue} AS media FROM ${tables}.cd_character_assets a
      JOIN ${tables}.cd_media f ON f.id=a.media_id WHERE a.owner_id=$1 AND a.character_id=$2 AND a.outfit_id IS NOT DISTINCT FROM $3::uuid
      AND a.kind=$4 AND a.key=$5 ORDER BY a.version DESC`, [owner, id, input.kind === "slot" ? input.outfitId : null, input.kind, input.key]);
    return rows;
  }

  async listMaterials(owner: string, input: ComicMaterialSearch) {
    const { rows } = await this.pool.query<ComicMaterial>(`SELECT ${materialColumns},v.version,${mediaValue} AS media
      FROM ${tables}.cd_materials m JOIN LATERAL (
        SELECT version,media_id FROM ${tables}.cd_material_versions WHERE material_id=m.id ORDER BY version DESC LIMIT 1
      ) v ON true JOIN ${tables}.cd_media f ON f.id=v.media_id WHERE m.owner_id=$1 AND (m.archived_at IS NOT NULL)=$2
      AND strpos(lower(m.name || ' ' || array_to_string(m.tags,' ')),lower($3))>0 AND ($4::text IS NULL OR m.kind=$4)
      ORDER BY m.updated_at DESC,m.id LIMIT $5 OFFSET $6`,
      [owner, input.archived === "true", input.query ?? "", input.kind ?? null, pageSize + 1, (input.page - 1) * pageSize]);
    return page(rows);
  }

  async materialInput(owner: string, id: string, db: ComicQuery = this.pool, lock = false): Promise<ComicMaterialInput> {
    const { rows } = await db.query<ComicMaterialInput>(`SELECT kind,name,category_key AS "categoryKey",tags FROM ${tables}.cd_materials
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL ${lock ? "FOR UPDATE" : ""}`, [owner, id]);
    if (!rows[0]) libraryMissing();
    return rows[0];
  }

  async addMaterial(owner: string, input: ComicMaterialInput, media: StoredComicMedia) {
    return libraryTransaction(this.pool, async db => {
      const { kind, name, categoryKey, tags } = input;
      await requireComicChoice(db, owner, kind, categoryKey);
      await insertMedia(db, media);
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
      await insertMedia(db, media);
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

  async archiveMaterial(owner: string, id: string) {
    const result = await this.pool.query(`UPDATE ${tables}.cd_materials SET archived_at=now(),updated_at=clock_timestamp()
      WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL`, [owner, id]);
    if (!result.rowCount) libraryMissing();
  }
}
