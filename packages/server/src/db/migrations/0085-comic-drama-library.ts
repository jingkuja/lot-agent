import type { Migration } from "../migration-runner.js";

export const comicDramaLibrary: Migration = {
  version: 85,
  name: "comic-drama-library",
  async up(client) {
    await client.query(`
      CREATE TABLE lot_comic_drama.cd_media (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id UUID PRIMARY KEY,
        storage_key TEXT NOT NULL UNIQUE,
        thumbnail_key TEXT UNIQUE,
        mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','audio/mpeg','audio/wav')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        width INTEGER CHECK (width > 0),
        height INTEGER CHECK (height > 0),
        duration_ms INTEGER CHECK (duration_ms > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id,id)
      );
      CREATE TABLE lot_comic_drama.cd_characters (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        aliases TEXT[] NOT NULL,
        tags TEXT[] NOT NULL,
        role_key TEXT,
        age TEXT NOT NULL,
        personality TEXT NOT NULL,
        appearance TEXT NOT NULL,
        archived_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id,id)
      );
      CREATE INDEX cd_characters_owner ON lot_comic_drama.cd_characters(owner_id,updated_at DESC,id);
      CREATE TABLE lot_comic_drama.cd_character_outfits (
        owner_id UUID NOT NULL,
        character_id UUID NOT NULL,
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        UNIQUE (owner_id,character_id,id),
        FOREIGN KEY (owner_id,character_id) REFERENCES lot_comic_drama.cd_characters(owner_id,id) ON DELETE CASCADE
      );
      CREATE TABLE lot_comic_drama.cd_character_assets (
        owner_id UUID NOT NULL,
        character_id UUID NOT NULL,
        outfit_id UUID,
        kind TEXT NOT NULL CHECK (kind IN ('slot','expression')),
        key TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        media_id UUID PRIMARY KEY,
        CHECK ((kind='slot') = (outfit_id IS NOT NULL)),
        UNIQUE NULLS NOT DISTINCT (character_id,outfit_id,kind,key,version),
        FOREIGN KEY (owner_id,character_id) REFERENCES lot_comic_drama.cd_characters(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,character_id,outfit_id) REFERENCES lot_comic_drama.cd_character_outfits(owner_id,character_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id)
      );
      CREATE TABLE lot_comic_drama.cd_materials (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind TEXT NOT NULL CHECK (kind IN ('scene','prop','sound','music','other')),
        name TEXT NOT NULL,
        category_key TEXT,
        tags TEXT[] NOT NULL,
        archived_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id,id)
      );
      CREATE INDEX cd_materials_owner ON lot_comic_drama.cd_materials(owner_id,kind,updated_at DESC,id);
      CREATE TABLE lot_comic_drama.cd_material_versions (
        owner_id UUID NOT NULL,
        material_id UUID NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        media_id UUID NOT NULL UNIQUE,
        PRIMARY KEY (material_id,version),
        FOREIGN KEY (owner_id,material_id) REFERENCES lot_comic_drama.cd_materials(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id)
      );
      CREATE TABLE lot_comic_drama.cd_dictionary (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        key TEXT NOT NULL,
        labels JSONB,
        inactive BOOLEAN NOT NULL DEFAULT false,
        sort INTEGER,
        PRIMARY KEY (owner_id,domain,key)
      );
    `);
  },
};
