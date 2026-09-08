import type { Migration } from "../migration-runner.js";

/** Audit whether a nightly portrait came from the LLM or deterministic fallback. */
export const cohortGenerationMethod: Migration = {
  version: 9,
  name: "digital-employee-cohort-generation-method",
  async up(client) {
    await client.query(`
      ALTER TABLE de_customer_cohort_snapshots
        ADD COLUMN IF NOT EXISTS generation_method VARCHAR(16) NOT NULL DEFAULT 'logic',
        ADD COLUMN IF NOT EXISTS model_id VARCHAR(160),
        ADD COLUMN IF NOT EXISTS fallback_reason TEXT;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'de_cohort_generation_method_check'
            AND conrelid = 'de_customer_cohort_snapshots'::regclass
        ) THEN
          ALTER TABLE de_customer_cohort_snapshots
            ADD CONSTRAINT de_cohort_generation_method_check
            CHECK (generation_method IN ('llm', 'logic'));
        END IF;
      END $$;
    `);
  },
};
