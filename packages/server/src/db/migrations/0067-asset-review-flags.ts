import type { Migration } from "../migration-runner.js";

/** Server findings on generated group copy, shown on the asset card before the owner publishes it. */
export const assetReviewFlags: Migration = {
  version: 67, name: "asset-review-flags",
  async up(client) {
    await client.query(`ALTER TABLE de_marketing_asset_library ADD COLUMN review_flags JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  },
};
