import type { Migration } from "../migration-runner.js";

export const marketingAnalysisRetention: Migration = {
  version: 43, name: "marketing-analysis-retention",
  async up(client) {
    await client.query("ALTER TABLE marketing_reference_analyses ADD COLUMN scratch_cleaned_at TIMESTAMPTZ");
  },
};
