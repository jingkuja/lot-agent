import type { Migration } from "../migration-runner.js";

/** One idempotent customer-group portrait per account and local day. */
export const customerCohortSnapshot: Migration = {
  version: 8,
  name: "digital-employee-customer-cohort-snapshot",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS de_customer_cohort_snapshots (
        user_id        VARCHAR(100) NOT NULL,
        snapshot_date  DATE NOT NULL,
        summary        TEXT NOT NULL,
        metrics        JSONB NOT NULL DEFAULT '{}',
        generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, snapshot_date)
      );

      CREATE INDEX IF NOT EXISTS idx_de_cohort_snapshots_user_generated
        ON de_customer_cohort_snapshots (user_id, generated_at DESC);
    `);
  },
};
