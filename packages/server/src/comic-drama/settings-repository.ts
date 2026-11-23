import type { Pool } from "pg";
import {
  comicUserPreferencesSchema, type ComicMedia, type ComicStylePreset, type ComicUserPreferences, type ComicUserSettings, type StoredComicMedia,
} from "@lot-agent/core/comic-drama";
import { requireComicChoice } from "./dictionary.js";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";
import { insertComicMedia } from "./library-repository.js";

const cd = "lot_comic_drama";
const mediaJson = `jsonb_build_object('id',m.id,'mime',m.mime,'sizeBytes',m.size_bytes,'width',m.width,'height',m.height,
  'durationMs',m.duration_ms,'hasThumbnail',m.thumbnail_key IS NOT NULL)`;

export class PgComicSettings {
  constructor(private readonly pool: Pool) {}

  async getPreferences(owner: string, db: ComicQuery = this.pool): Promise<ComicUserPreferences> {
    const { rows } = await db.query<{ preferences: unknown }>(
      `SELECT preferences FROM ${cd}.cd_user_state WHERE owner_id=$1`, [owner],
    );
    // `.strip()` deliberately ignores preferences written by older versions,
    // including the removed user-selectable director text model.
    const parsed = comicUserPreferencesSchema.safeParse(rows[0]?.preferences ?? {});
    if (!parsed.success) return {};
    const { defaultImageModel, defaultVideoModel } = parsed.data;
    return { defaultImageModel, defaultVideoModel };
  }

  async updatePreferences(owner: string, patch: ComicUserPreferences): Promise<ComicUserPreferences> {
    const { defaultImageModel, defaultVideoModel } = patch;
    const { rows: [row] } = await this.pool.query<{ preferences: ComicUserPreferences }>(
      `INSERT INTO ${cd}.cd_user_state AS s(owner_id, preferences) VALUES($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET preferences = (s.preferences - 'defaultTextModel') || excluded.preferences
       RETURNING preferences`,
      [owner, { defaultImageModel, defaultVideoModel }],
    );
    return row.preferences;
  }

  async listStylePresets(owner: string): Promise<ComicStylePreset[]> {
    const { rows } = await this.pool.query<{ styleKey: string; mediaId: string; media: ComicMedia; updatedAt: Date }>(
      `SELECT p.style_key AS "styleKey", p.media_id AS "mediaId", ${mediaJson} AS media, p.updated_at AS "updatedAt"
       FROM ${cd}.cd_style_presets p
       JOIN ${cd}.cd_media m ON (m.owner_id, m.id) = (p.owner_id, p.media_id)
       WHERE p.owner_id=$1 ORDER BY p.style_key`,
      [owner],
    );
    return rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
  }

  async getStylePreset(owner: string, styleKey: string): Promise<ComicStylePreset | null> {
    const { rows } = await this.pool.query<{ styleKey: string; mediaId: string; media: ComicMedia; updatedAt: Date }>(
      `SELECT p.style_key AS "styleKey", p.media_id AS "mediaId", ${mediaJson} AS media, p.updated_at AS "updatedAt"
       FROM ${cd}.cd_style_presets p
       JOIN ${cd}.cd_media m ON (m.owner_id, m.id) = (p.owner_id, p.media_id)
       WHERE p.owner_id=$1 AND p.style_key=$2`,
      [owner, styleKey],
    );
    return rows[0] ? { ...rows[0], updatedAt: rows[0].updatedAt.toISOString() } : null;
  }

  async bindStylePreset(owner: string, styleKey: string, mediaId: string): Promise<ComicStylePreset> {
    return libraryTransaction(this.pool, async db => {
      await requireComicChoice(db, owner, "style", styleKey);
      const { rows: [media] } = await db.query<{ id: string; mime: string }>(
        `SELECT id, mime FROM ${cd}.cd_media WHERE owner_id=$1 AND id=$2`, [owner, mediaId],
      );
      if (!media) libraryMissing();
      if (!media.mime.startsWith("image/")) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
      await db.query(
        `INSERT INTO ${cd}.cd_style_presets(owner_id, style_key, media_id, updated_at) VALUES($1, $2, $3, now())
         ON CONFLICT (owner_id, style_key) DO UPDATE SET media_id = excluded.media_id, updated_at = now()`,
        [owner, styleKey, mediaId],
      );
      const { rows: [row] } = await db.query<{ styleKey: string; mediaId: string; media: ComicMedia; updatedAt: Date }>(
        `SELECT p.style_key AS "styleKey", p.media_id AS "mediaId", ${mediaJson} AS media, p.updated_at AS "updatedAt"
         FROM ${cd}.cd_style_presets p JOIN ${cd}.cd_media m ON (m.owner_id, m.id) = (p.owner_id, p.media_id)
         WHERE p.owner_id=$1 AND p.style_key=$2`,
        [owner, styleKey],
      );
      return { ...row, updatedAt: row.updatedAt.toISOString() };
    });
  }

  async uploadStylePreset(owner: string, styleKey: string, media: StoredComicMedia): Promise<ComicStylePreset> {
    return libraryTransaction(this.pool, async db => {
      await requireComicChoice(db, owner, "style", styleKey);
      await insertComicMedia(db, media);
      await db.query(
        `INSERT INTO ${cd}.cd_style_presets(owner_id, style_key, media_id, updated_at) VALUES($1, $2, $3, now())
         ON CONFLICT (owner_id, style_key) DO UPDATE SET media_id = excluded.media_id, updated_at = now()`,
        [owner, styleKey, media.id],
      );
      const { rows: [row] } = await db.query<{ styleKey: string; mediaId: string; media: ComicMedia; updatedAt: Date }>(
        `SELECT p.style_key AS "styleKey", p.media_id AS "mediaId", ${mediaJson} AS media, p.updated_at AS "updatedAt"
         FROM ${cd}.cd_style_presets p JOIN ${cd}.cd_media m ON (m.owner_id, m.id) = (p.owner_id, p.media_id)
         WHERE p.owner_id=$1 AND p.style_key=$2`,
        [owner, styleKey],
      );
      return { ...row, updatedAt: row.updatedAt.toISOString() };
    });
  }

  async removeStylePreset(owner: string, styleKey: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${cd}.cd_style_presets WHERE owner_id=$1 AND style_key=$2`, [owner, styleKey]);
  }

  async getAll(owner: string): Promise<ComicUserSettings> {
    const [preferences, stylePresets] = await Promise.all([this.getPreferences(owner), this.listStylePresets(owner)]);
    return { preferences, stylePresets };
  }
}
