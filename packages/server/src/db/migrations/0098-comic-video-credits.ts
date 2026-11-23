import type { Migration } from "../migration-runner.js";

export const comicVideoCredits: Migration = {
  version: 98,
  name: "comic-video-credits",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_takes
        ADD COLUMN credit_check jsonb,
        ADD COLUMN credit_override boolean NOT NULL DEFAULT false;
      CREATE INDEX idx_cd_takes_credit_pause ON lot_comic_drama.cd_takes(owner_id, request_id) WHERE credit_check IS NOT NULL;
    `);
  },
};
