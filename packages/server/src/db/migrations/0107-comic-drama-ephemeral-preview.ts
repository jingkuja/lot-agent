import type { Migration } from "../migration-runner.js";

export const comicDramaEphemeralPreview: Migration = {
  version: 107, name: "comic-drama-ephemeral-preview",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_renders
        ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX cd_render_ephemeral_cleanup
        ON lot_comic_drama.cd_renders(created_at, id)
        WHERE ephemeral = TRUE AND deleted_at IS NULL;
    `);
  },
};
