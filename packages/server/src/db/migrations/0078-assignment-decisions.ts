import type { Migration } from "../migration-runner.js";

/**
 * What responsive tasks need beyond 0077. The answer travels in next_message until the turn it starts has
 * ended, so a worker lost in between cannot drop it. A decision can be quoted through its first notice or
 * its reminder, so both message ids are kept.
 */
export const assignmentDecisions: Migration = {
  version: 78, name: "assignment-decisions",
  async up(client) {
    await client.query(`
      ALTER TABLE de_assignments ADD COLUMN IF NOT EXISTS next_message TEXT;
      ALTER TABLE de_assignment_decisions
        ADD COLUMN IF NOT EXISTS multi_select BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS feishu_reminder_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_de_assignment_decisions_user ON de_assignment_decisions (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_de_assignment_decisions_due ON de_assignment_decisions (created_at)
        WHERE answered_at IS NULL AND reminded_at IS NULL;
    `);
  },
};
