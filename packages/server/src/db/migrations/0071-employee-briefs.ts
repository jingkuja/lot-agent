import type { Migration } from "../migration-runner.js";

/** One morning brief per account and day: counts and references only, the words come from the interface. */
export const employeeBriefs: Migration = {
  version: 71, name: "employee-briefs",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS de_employee_briefs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             VARCHAR(100) NOT NULL,
        brief_date          DATE NOT NULL,
        counts              JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
        item_refs           JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(item_refs) = 'array'),
        feishu_attempted_at TIMESTAMPTZ,
        delivered_at        TIMESTAMPTZ,
        read_at             TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, brief_date)
      );
      CREATE INDEX IF NOT EXISTS idx_de_employee_briefs_undelivered
        ON de_employee_briefs (created_at) WHERE feishu_attempted_at IS NULL;
    `);
  },
};
