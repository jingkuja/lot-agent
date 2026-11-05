import type { Migration } from "../migration-runner.js";

/**
 * Scheduled work. A run row is written for everything that happens to an occurrence, including
 * skipped and missed ones, so "why didn't it run" always has an answer. Deleting a schedule keeps its history.
 */
export const employeeSchedules: Migration = {
  version: 73, name: "employee-schedules",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS de_employee_schedules (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     VARCHAR(100) NOT NULL,
        template    TEXT NOT NULL CHECK (template IN ('follow_up_prep', 'weekly_review')),
        timing      JSONB NOT NULL CHECK (jsonb_typeof(timing) = 'object'),
        timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        enabled     BOOLEAN NOT NULL DEFAULT true,
        next_run_at TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        version     INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_de_employee_schedules_user ON de_employee_schedules (user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_de_employee_schedules_due ON de_employee_schedules (next_run_at) WHERE enabled;

      CREATE TABLE IF NOT EXISTS de_employee_schedule_runs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        schedule_id     UUID REFERENCES de_employee_schedules(id) ON DELETE SET NULL,
        user_id         VARCHAR(100) NOT NULL,
        template        TEXT NOT NULL,
        scheduled_for   TIMESTAMPTZ NOT NULL,
        local_date      DATE NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'missed')),
        reason          TEXT,
        task_id         UUID,
        model_id        TEXT,
        report          JSONB,
        acknowledged_at TIMESTAMPTZ,
        started_at      TIMESTAMPTZ,
        finished_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (schedule_id, scheduled_for)
      );
      CREATE INDEX IF NOT EXISTS idx_de_employee_schedule_runs_user ON de_employee_schedule_runs (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_de_employee_schedule_runs_day ON de_employee_schedule_runs (user_id, template, local_date);
      CREATE INDEX IF NOT EXISTS idx_de_employee_schedule_runs_open ON de_employee_schedule_runs (created_at)
        WHERE status IN ('queued', 'running');
    `);
  },
};
