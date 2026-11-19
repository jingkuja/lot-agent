import type { Migration } from "../migration-runner.js";

export const comicDramaEdits: Migration = {
  version: 89, name: "comic-drama-edits",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_takes ADD UNIQUE (owner_id,id);

      CREATE TABLE lot_comic_drama.cd_edits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        series_id UUID, title TEXT NOT NULL, revision INT NOT NULL DEFAULT 1 CHECK (revision>0),
        timeline JSONB NOT NULL CHECK (timeline->>'schemaVersion'='1'),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (owner_id,id),
        FOREIGN KEY (owner_id,series_id) REFERENCES lot_comic_drama.cd_series(owner_id,id)
      );
      CREATE INDEX cd_edit_listing ON lot_comic_drama.cd_edits(owner_id,updated_at DESC,id DESC);

      CREATE TABLE lot_comic_drama.cd_edit_takes (
        owner_id UUID NOT NULL, edit_id UUID NOT NULL, take_id UUID NOT NULL,
        PRIMARY KEY (edit_id,take_id),
        FOREIGN KEY (owner_id,edit_id) REFERENCES lot_comic_drama.cd_edits(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,take_id) REFERENCES lot_comic_drama.cd_takes(owner_id,id)
      );
      CREATE INDEX cd_edit_take_references ON lot_comic_drama.cd_edit_takes(owner_id,take_id);
      CREATE TABLE lot_comic_drama.cd_edit_media (
        owner_id UUID NOT NULL, edit_id UUID NOT NULL, media_id UUID NOT NULL,
        PRIMARY KEY (edit_id,media_id),
        FOREIGN KEY (owner_id,edit_id) REFERENCES lot_comic_drama.cd_edits(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id)
      );
      CREATE INDEX cd_edit_media_references ON lot_comic_drama.cd_edit_media(owner_id,media_id);

      CREATE TABLE lot_comic_drama.cd_character_voice (
        owner_id UUID NOT NULL, character_id UUID NOT NULL,
        binding JSONB NOT NULL, voice_version UUID NOT NULL,
        clone_fingerprint TEXT, authorized_at TIMESTAMPTZ,
        PRIMARY KEY (owner_id,character_id),
        FOREIGN KEY (owner_id,character_id) REFERENCES lot_comic_drama.cd_characters(owner_id,id) ON DELETE CASCADE,
        CHECK ((clone_fingerprint IS NOT NULL)=(authorized_at IS NOT NULL))
      );
      CREATE TABLE lot_comic_drama.cd_speech_cache (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('submitting','ready','failed','unknown')),
        media_id UUID, gateway_request_id TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id,fingerprint),
        FOREIGN KEY (owner_id,media_id) REFERENCES lot_comic_drama.cd_media(owner_id,id),
        CHECK ((status='ready')=(media_id IS NOT NULL))
      );
    `);
  },
};
