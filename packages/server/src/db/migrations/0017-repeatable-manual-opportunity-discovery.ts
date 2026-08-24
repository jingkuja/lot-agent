import type { Migration, QueryClient } from "../migration-runner.js";

/** Allow explicit manual scans while keeping daily scans idempotent by key. */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    ALTER TABLE de_follow_up_suggestion_runs
      DROP CONSTRAINT IF EXISTS de_follow_up_suggestion_runs_user_id_scan_date_key;

    CREATE INDEX IF NOT EXISTS idx_de_follow_up_runs_user_scan_date
      ON de_follow_up_suggestion_runs (user_id, scan_date DESC);
  `);
}

export const repeatableManualOpportunityDiscovery: Migration = {
  version: 17,
  name: "repeatable-manual-opportunity-discovery",
  up,
};
