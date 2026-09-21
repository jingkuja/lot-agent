import type { Migration } from "../migration-runner.js";

export const imageShare: Migration = {
  version: 23,
  name: "image-share",
  async up(client) {
    await client.query(`
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS share_token VARCHAR(48),
                         ADD COLUMN IF NOT EXISTS share_title VARCHAR(80);
      CREATE UNIQUE INDEX IF NOT EXISTS assets_share_token_uidx
        ON assets (share_token) WHERE share_token IS NOT NULL;
      CREATE INDEX IF NOT EXISTS assets_user_storage_key_idx ON assets (user_id, storage_key);
    `);
  },
};
