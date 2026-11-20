import type { Migration } from "../migration-runner.js";

export const comicDramaV1Features: Migration = {
  version: 95,
  name: "comic-drama-v1-features",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_user_state
        ADD COLUMN editor_last_id UUID,
        ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD FOREIGN KEY (owner_id, editor_last_id)
          REFERENCES lot_comic_drama.cd_edits(owner_id, id) ON DELETE SET NULL (editor_last_id);

      ALTER TABLE lot_comic_drama.cd_clips
        ADD COLUMN keyframe_media_id UUID REFERENCES lot_comic_drama.cd_media(id) ON DELETE SET NULL;

      ALTER TABLE lot_comic_drama.cd_character_outfits
        ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE lot_comic_drama.cd_character_assets
        ADD COLUMN deleted_at TIMESTAMPTZ;

      ALTER TABLE lot_comic_drama.cd_material_versions
        DROP CONSTRAINT IF EXISTS cd_material_versions_media_id_key;

      CREATE TABLE lot_comic_drama.cd_style_presets (
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        style_key TEXT NOT NULL,
        media_id UUID NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, style_key),
        FOREIGN KEY (owner_id, media_id) REFERENCES lot_comic_drama.cd_media(owner_id, id) ON DELETE CASCADE
      );
    `);
  },
};
