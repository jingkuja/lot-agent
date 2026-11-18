import type { Migration } from "../migration-runner.js";

export const comicDramaCast: Migration = {
  version: 86, name: "comic-drama-cast",
  async up(client) {
    await client.query(`
      CREATE TABLE lot_comic_drama.cd_series_cast (
        owner_id UUID NOT NULL,
        series_id UUID NOT NULL,
        character_id UUID NOT NULL,
        outfit_id UUID NOT NULL,
        snapshot JSONB NOT NULL CHECK (snapshot->>'schemaVersion' = '1'),
        PRIMARY KEY (series_id,character_id),
        FOREIGN KEY (owner_id,series_id) REFERENCES lot_comic_drama.cd_series(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id,character_id,outfit_id) REFERENCES lot_comic_drama.cd_character_outfits(owner_id,character_id,id)
      );
    `);
  },
};
