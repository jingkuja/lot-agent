import type { Migration, QueryClient } from "../migration-runner.js";

async function up(client: QueryClient): Promise<void> {
  await client.query(`
    ALTER TABLE de_marketing_campaigns
      ADD COLUMN IF NOT EXISTS selected_assets JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(selected_assets) = 'object');
  `);
}

export const campaignSelectedAssets: Migration = {
  version: 15,
  name: "digital-employee-campaign-selected-assets",
  up,
};
