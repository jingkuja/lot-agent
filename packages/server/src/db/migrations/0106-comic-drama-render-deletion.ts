import type { Migration } from "../migration-runner.js";

export const comicDramaRenderDeletion: Migration = {
  version: 106, name: "comic-drama-render-deletion",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_renders
        ADD COLUMN deleted_at TIMESTAMPTZ,
        ADD COLUMN deleted_storage_key TEXT,
        ADD CHECK (deleted_at IS NULL OR media_id IS NULL),
        ADD CHECK (deleted_storage_key IS NULL OR deleted_at IS NOT NULL);
      CREATE INDEX cd_render_file_cleanup ON lot_comic_drama.cd_renders(deleted_at,id) WHERE deleted_storage_key IS NOT NULL;
    `);
  },
};
