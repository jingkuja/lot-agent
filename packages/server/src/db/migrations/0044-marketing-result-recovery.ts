import type { Migration } from "../migration-runner.js";

export const marketingResultRecovery: Migration = {
  version: 44, name: "marketing-result-recovery",
  async up(client) {
    await client.query(`ALTER TABLE marketing_text_operations
      ADD COLUMN input_snapshot JSONB,
      ADD COLUMN parser_version TEXT,
      DROP CONSTRAINT marketing_text_operations_status_check,
      ADD CONSTRAINT marketing_text_operations_status_check CHECK(status IN ('running','unknown','needs_apply','failed','succeeded','conflict'));
      DROP INDEX marketing_text_operations_active;
      CREATE UNIQUE INDEX marketing_text_operations_active ON marketing_text_operations(project_id)
        WHERE status IN ('running','unknown','needs_apply');
      ALTER TABLE marketing_reference_analyses ADD COLUMN summary_inputs JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  },
};
