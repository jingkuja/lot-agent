import type { Migration } from "../migration-runner.js";

export const marketingAutomaticCreation: Migration = {
  version: 40, name: "marketing-automatic-creation",
  async up(client) {
    await client.query(`
      ALTER TABLE marketing_reference_analyses ADD COLUMN creation_context JSONB;
      ALTER TABLE marketing_reference_analyses ALTER COLUMN budget_limit DROP NOT NULL;
      ALTER TABLE marketing_reference_analyses ALTER COLUMN pricing SET DEFAULT '[]'::jsonb;
      ALTER TABLE marketing_analysis_steps ALTER COLUMN reserved_cost SET DEFAULT 0;
      UPDATE marketing_reference_analyses SET reserved_cost=0;
      UPDATE marketing_analysis_steps SET reserved_cost=0;
    `);
  },
};
