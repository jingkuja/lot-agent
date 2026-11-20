import type { Migration } from "../migration-runner.js";

/** Recurring assignments reuse ordinary assignment rows; the occurrence key makes dispatch idempotent. */
export const assignmentSchedules: Migration = {
  version: 96, name: "assignment-schedules",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS de_assignment_schedules (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            VARCHAR(100) NOT NULL,
        assignment_input   JSONB NOT NULL CHECK (jsonb_typeof(assignment_input) = 'object'),
        timing             JSONB NOT NULL CHECK (jsonb_typeof(timing) = 'object'),
        timezone           TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        enabled            BOOLEAN NOT NULL DEFAULT true,
        next_run_at        TIMESTAMPTZ,
        last_run_at        TIMESTAMPTZ,
        last_assignment_id UUID REFERENCES de_assignments(id) ON DELETE SET NULL,
        last_error         TEXT,
        version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_de_assignment_schedules_user ON de_assignment_schedules (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_de_assignment_schedules_due ON de_assignment_schedules (next_run_at) WHERE enabled;

      ALTER TABLE de_assignments ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES de_assignment_schedules(id) ON DELETE SET NULL;
      ALTER TABLE de_assignments ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_de_assignments_schedule_occurrence
        ON de_assignments (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL AND id = root_id;
    `);
  },
};
