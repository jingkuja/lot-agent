import type { Migration, QueryClient } from "../migration-runner.js";

/** Turns the follow-up foundation into the user-facing opportunity workflow. */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION next_daily_run(
      requested_timezone TEXT,
      requested_time TIME,
      requested_from TIMESTAMPTZ DEFAULT now()
    ) RETURNS TIMESTAMPTZ AS $$
    DECLARE candidate TIMESTAMPTZ;
    BEGIN
      candidate := (((requested_from AT TIME ZONE requested_timezone)::date + requested_time)
        AT TIME ZONE requested_timezone);
      IF candidate <= requested_from THEN
        candidate := ((((requested_from AT TIME ZONE requested_timezone)::date + 1) + requested_time)
          AT TIME ZONE requested_timezone);
      END IF;
      RETURN candidate;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `);
  await client.query(`
    ALTER TABLE de_follow_up_suggestion_runs
      ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_de_follow_up_runs_task
      ON de_follow_up_suggestion_runs (task_id) WHERE task_id IS NOT NULL;

    ALTER TABLE de_follow_up_suggestions
      ADD COLUMN IF NOT EXISTS opportunity_type VARCHAR(32) NOT NULL DEFAULT 'prospect_progress',
      ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS readiness VARCHAR(20) NOT NULL DEFAULT 'actionable',
      ADD COLUMN IF NOT EXISTS risk_flags JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS decision_reason TEXT,
      ADD COLUMN IF NOT EXISTS product_key VARCHAR(160),
      ADD COLUMN IF NOT EXISTS product_name VARCHAR(200);

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_de_opportunity_type') THEN
        ALTER TABLE de_follow_up_suggestions ADD CONSTRAINT ck_de_opportunity_type CHECK (
          opportunity_type IN ('prospect_progress','silent_reengage','event_invitation','renewal','risk_recovery',
            'new_lead_contact','trial_conversion','repurchase','referral','cohort_marketing')
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_de_opportunity_readiness') THEN
        ALTER TABLE de_follow_up_suggestions ADD CONSTRAINT ck_de_opportunity_readiness CHECK (
          readiness IN ('actionable','tryable','needs_info','paused')
        );
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_de_opportunities_user_type_priority
      ON de_follow_up_suggestions (user_id, opportunity_type, priority, suggested_at DESC);
  `);

  await client.query(`
    ALTER TABLE de_follow_up_tasks
      DROP CONSTRAINT IF EXISTS de_follow_up_tasks_status_check;
    ALTER TABLE de_follow_up_tasks
      ADD CONSTRAINT de_follow_up_tasks_status_check
      CHECK (status IN ('pending', 'awaiting_result', 'completed', 'cancelled'));
    ALTER TABLE de_follow_up_tasks
      ADD COLUMN IF NOT EXISTS opportunity_type VARCHAR(32),
      ADD COLUMN IF NOT EXISTS result_criteria TEXT,
      ADD COLUMN IF NOT EXISTS product_key VARCHAR(160),
      ADD COLUMN IF NOT EXISTS product_name VARCHAR(200),
      ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS close_reason VARCHAR(40);

    ALTER TABLE de_follow_up_records
      ADD COLUMN IF NOT EXISTS customer_quote TEXT,
      ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS profile_update JSONB NOT NULL DEFAULT '{}';

    ALTER TABLE de_copy_projects
      ADD COLUMN IF NOT EXISTS follow_up_task_id UUID REFERENCES de_follow_up_tasks(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_de_copy_projects_follow_up_task
      ON de_copy_projects (user_id, follow_up_task_id) WHERE follow_up_task_id IS NOT NULL;
  `);
}

export const opportunityAdvisor: Migration = {
  version: 12,
  name: "digital-employee-opportunity-advisor",
  up,
};
