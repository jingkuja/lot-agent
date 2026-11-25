import type { Migration } from "../migration-runner.js";

export const comicDramaPreparation: Migration = {
  version: 104,
  name: "comic-drama-preparation",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_dramas
        ADD COLUMN outline TEXT NOT NULL DEFAULT '',
        ADD COLUMN script_content TEXT NOT NULL DEFAULT '';

      CREATE TABLE lot_comic_drama.cd_drama_cast (
        owner_id UUID NOT NULL,
        drama_id UUID NOT NULL,
        character_id UUID NOT NULL,
        outfit_id UUID NOT NULL,
        snapshot JSONB NOT NULL CHECK (snapshot->>'schemaVersion' = '1'),
        PRIMARY KEY (drama_id, character_id),
        FOREIGN KEY (owner_id, drama_id)
          REFERENCES lot_comic_drama.cd_dramas(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id, character_id, outfit_id)
          REFERENCES lot_comic_drama.cd_character_outfits(owner_id, character_id, id)
      );

      INSERT INTO lot_comic_drama.cd_drama_cast (owner_id, drama_id, character_id, outfit_id, snapshot)
      SELECT DISTINCT ON (s.drama_id, sc.character_id)
        sc.owner_id, s.drama_id, sc.character_id, sc.outfit_id, sc.snapshot
      FROM lot_comic_drama.cd_series_cast sc
      JOIN lot_comic_drama.cd_series s ON s.owner_id = sc.owner_id AND s.id = sc.series_id
      JOIN lot_comic_drama.cd_dramas d ON d.owner_id = s.owner_id AND d.id = s.drama_id
      WHERE s.deleted_at IS NULL AND d.deleted_at IS NULL
      ORDER BY s.drama_id, sc.character_id, s.episode_no ASC, s.created_at ASC, s.id ASC
      ON CONFLICT (drama_id, character_id) DO NOTHING;

      ALTER TABLE lot_comic_drama.cd_user_state
        ADD COLUMN current_drama_id UUID,
        ADD CONSTRAINT cd_user_state_drama_fk
          FOREIGN KEY (owner_id, current_drama_id)
          REFERENCES lot_comic_drama.cd_dramas(owner_id, id);

      UPDATE lot_comic_drama.cd_user_state u
      SET current_drama_id = s.drama_id
      FROM lot_comic_drama.cd_series s
      WHERE s.owner_id = u.owner_id AND s.id = u.current_series_id AND s.deleted_at IS NULL;
    `);
  },
};
