import type { Migration } from "../migration-runner.js";

/** Small merchants describe their company or store plainly; logos and store photos stay in visual_assets. */
export const businessProfile: Migration = {
  version: 80, name: "business-profile",
  async up(client) {
    await client.query(`
      ALTER TABLE marketing_brand_assets
        ADD COLUMN IF NOT EXISTS business_name VARCHAR(200) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS business_intro TEXT NOT NULL DEFAULT ''
    `);
  },
};
