import type { Migration } from "../migration-runner.js";

/** When the current analysis run was submitted (created, or resumed with 继续生成), so the page can show
 * a 5-minute progress bar that survives a refresh. Existing rows stay NULL and fall back to `created_at`. */
export const marketingAnalysisSubmitted: Migration = {
  version: 65, name: "marketing-analysis-submitted",
  async up(client) {
    await client.query(`ALTER TABLE marketing_reference_analyses ADD COLUMN submitted_at TIMESTAMPTZ;
      ALTER TABLE marketing_reference_analyses ALTER COLUMN submitted_at SET DEFAULT now();`);
  },
};
