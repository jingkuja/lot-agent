import type { Migration } from "../migration-runner.js";

export const comicDramaMaterialGeneration: Migration = {
  version: 99, name: "comic-drama-material-generation",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_generation_requests
        ADD COLUMN material_id UUID,
        DROP CONSTRAINT cd_generation_requests_check,
        ADD CONSTRAINT cd_generation_requests_check CHECK (num_nonnulls(series_id,character_id,material_id)=1),
        ADD CONSTRAINT cd_generation_requests_material_fk FOREIGN KEY (owner_id,material_id)
          REFERENCES lot_comic_drama.cd_materials(owner_id,id) ON DELETE CASCADE;
    `);
  },
};
