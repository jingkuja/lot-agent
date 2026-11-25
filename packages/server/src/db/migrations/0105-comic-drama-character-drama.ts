import type { Migration } from "../migration-runner.js";

export const comicDramaCharacterDrama: Migration = {
  version: 105,
  name: "comic-drama-character-drama",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_characters
        ADD COLUMN drama_id UUID;

      ALTER TABLE lot_comic_drama.cd_characters
        ADD CONSTRAINT cd_characters_drama_fk
          FOREIGN KEY (owner_id, drama_id)
          REFERENCES lot_comic_drama.cd_dramas(owner_id, id);

      CREATE INDEX cd_characters_owner_drama_idx
        ON lot_comic_drama.cd_characters(owner_id, drama_id, updated_at DESC, id)
        WHERE drama_id IS NOT NULL;

      WITH candidate AS (
        SELECT DISTINCT ON (owner_id, character_id)
          owner_id, character_id, drama_id
        FROM (
          SELECT dc.owner_id, dc.character_id, dc.drama_id, 0 AS prio, d.created_at, d.id AS sort_id
          FROM lot_comic_drama.cd_drama_cast dc
          JOIN lot_comic_drama.cd_dramas d ON d.owner_id = dc.owner_id AND d.id = dc.drama_id
          WHERE d.deleted_at IS NULL
          UNION ALL
          SELECT sc.owner_id, sc.character_id, s.drama_id, 1 AS prio, d.created_at, d.id AS sort_id
          FROM lot_comic_drama.cd_series_cast sc
          JOIN lot_comic_drama.cd_series s ON s.owner_id = sc.owner_id AND s.id = sc.series_id
          JOIN lot_comic_drama.cd_dramas d ON d.owner_id = s.owner_id AND d.id = s.drama_id
          WHERE s.deleted_at IS NULL AND d.deleted_at IS NULL
        ) matched
        ORDER BY owner_id, character_id, prio ASC, created_at ASC, sort_id ASC
      )
      UPDATE lot_comic_drama.cd_characters c
      SET drama_id = candidate.drama_id
      FROM candidate
      WHERE c.owner_id = candidate.owner_id AND c.id = candidate.character_id AND c.drama_id IS NULL;
    `);
  },
};
