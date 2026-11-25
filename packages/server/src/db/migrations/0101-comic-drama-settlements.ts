import type { Migration } from "../migration-runner.js";

export const comicDramaSettlements: Migration = {
  version: 101,
  name: "comic-drama-settlements",
  async up(client) {
    await client.query(`
      ALTER TABLE lot_comic_drama.cd_takes ADD COLUMN settlement_checked_at TIMESTAMPTZ;
      CREATE INDEX cd_takes_settlement_due_idx ON lot_comic_drama.cd_takes
        (settlement_checked_at NULLS FIRST, created_at, id) WHERE settled_amount_micros IS NULL;
      CREATE UNIQUE INDEX cd_takes_gateway_settlement_unique ON lot_comic_drama.cd_takes
        (owner_id, settled_source) WHERE settled_source LIKE 'tokenhub:%';
    `);
  },
};
