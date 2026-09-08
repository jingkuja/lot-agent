import type { Migration } from "../migration-runner.js";

/** Per-user opt-in for the nightly, billable customer-cohort LLM task. */
export const cohortAutomationSettings: Migration = {
  version: 20,
  name: "cohort-automation-settings",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS de_cohort_automation_settings (
        user_id      VARCHAR(100) PRIMARY KEY,
        enabled      BOOLEAN NOT NULL DEFAULT false,
        last_run_at  TIMESTAMPTZ,
        version      INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_de_cohort_automation_enabled
        ON de_cohort_automation_settings (user_id)
        WHERE enabled = true;
    `);
  },
};
