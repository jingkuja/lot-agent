import type { Migration, QueryClient } from "../migration-runner.js";

/**
 * Digital-employee workflow foundation after customer profiles:
 *
 * - AI follow-up scans produce suggestions, never tasks directly.
 * - Accepting a suggestion can create at most one formal task.
 * - Actual contacts are immutable records, separate from mutable tasks.
 * - Copy projects own durable briefs and editable draft/version history;
 *   model calls remain auditable generation runs rather than business facts.
 *
 * Every business table carries user_id. Foreign keys provide lifecycle
 * integrity; the service layer additionally verifies that related rows belong
 * to the same user before writing because the legacy profile key is id-only.
 */
async function up(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS de_follow_up_suggestion_runs (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                   VARCHAR(100) NOT NULL,
      idempotency_key           VARCHAR(200) NOT NULL,
      scan_date                 DATE NOT NULL,
      model_id                  VARCHAR(160),
      prompt_version            VARCHAR(80) NOT NULL,
      candidate_count           INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
      created_suggestion_count  INTEGER NOT NULL DEFAULT 0 CHECK (created_suggestion_count >= 0),
      skipped_suggestion_count  INTEGER NOT NULL DEFAULT 0 CHECK (skipped_suggestion_count >= 0),
      status                    VARCHAR(16) NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      error_code                VARCHAR(80),
      started_at                TIMESTAMPTZ,
      finished_at               TIMESTAMPTZ,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key),
      UNIQUE (user_id, scan_date)
    );

    CREATE INDEX IF NOT EXISTS idx_de_follow_up_runs_user_created
      ON de_follow_up_suggestion_runs (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_follow_up_runs_status
      ON de_follow_up_suggestion_runs (status, created_at)
      WHERE status IN ('pending', 'running');
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_follow_up_suggestions (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            VARCHAR(100) NOT NULL,
      profile_id         UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      suggestion_run_id  UUID NOT NULL REFERENCES de_follow_up_suggestion_runs(id) ON DELETE CASCADE,
      title              VARCHAR(300) NOT NULL,
      objective          TEXT NOT NULL,
      follow_up_method   VARCHAR(32),
      suggested_at       TIMESTAMPTZ NOT NULL,
      priority           VARCHAR(16) NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low', 'normal', 'high')),
      reason             TEXT NOT NULL,
      confidence         NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      dedup_key          VARCHAR(200) NOT NULL,
      status             VARCHAR(16) NOT NULL DEFAULT 'suggested'
                         CHECK (status IN ('suggested', 'accepted', 'dismissed', 'expired')),
      decided_at         TIMESTAMPTZ,
      version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, dedup_key)
    );

    CREATE INDEX IF NOT EXISTS idx_de_follow_up_suggestions_user_status_time
      ON de_follow_up_suggestions (user_id, status, suggested_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_follow_up_suggestions_profile
      ON de_follow_up_suggestions (user_id, profile_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_follow_up_suggestions_run
      ON de_follow_up_suggestions (suggestion_run_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_follow_up_tasks (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           VARCHAR(100) NOT NULL,
      owner_user_id     VARCHAR(100) NOT NULL,
      profile_id        UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      suggestion_id     UUID UNIQUE REFERENCES de_follow_up_suggestions(id) ON DELETE RESTRICT,
      source            VARCHAR(16) NOT NULL CHECK (source IN ('manual', 'ai_accepted')),
      title             VARCHAR(300) NOT NULL,
      objective         TEXT NOT NULL,
      note              TEXT NOT NULL DEFAULT '',
      follow_up_method  VARCHAR(32),
      priority          VARCHAR(16) NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low', 'normal', 'high')),
      scheduled_at      TIMESTAMPTZ NOT NULL,
      status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'completed', 'cancelled')),
      completed_at      TIMESTAMPTZ,
      cancelled_at      TIMESTAMPTZ,
      version           INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (
        (source = 'manual' AND suggestion_id IS NULL)
        OR (source = 'ai_accepted' AND suggestion_id IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_de_follow_up_tasks_user_status_scheduled
      ON de_follow_up_tasks (user_id, status, scheduled_at, id);
    CREATE INDEX IF NOT EXISTS idx_de_follow_up_tasks_owner_status_scheduled
      ON de_follow_up_tasks (owner_user_id, status, scheduled_at, id);
    CREATE INDEX IF NOT EXISTS idx_de_follow_up_tasks_profile
      ON de_follow_up_tasks (user_id, profile_id, scheduled_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_follow_up_automation_settings (
      user_id         VARCHAR(100) PRIMARY KEY,
      enabled         BOOLEAN NOT NULL DEFAULT false,
      timezone        VARCHAR(80) NOT NULL DEFAULT 'Asia/Shanghai',
      daily_run_time  TIME NOT NULL DEFAULT '09:00',
      next_run_at     TIMESTAMPTZ,
      model_id        VARCHAR(160),
      last_run_at     TIMESTAMPTZ,
      version         INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_de_follow_up_settings_due
      ON de_follow_up_automation_settings (next_run_at, user_id)
      WHERE enabled = true AND next_run_at IS NOT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_follow_up_records (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           VARCHAR(100) NOT NULL,
      profile_id        UUID NOT NULL REFERENCES de_customer_profiles(id) ON DELETE CASCADE,
      task_id           UUID REFERENCES de_follow_up_tasks(id) ON DELETE SET NULL,
      occurred_at       TIMESTAMPTZ NOT NULL,
      follow_up_method  VARCHAR(32),
      outcome           VARCHAR(32) NOT NULL,
      note              TEXT NOT NULL DEFAULT '',
      next_action       TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_de_follow_up_records_user_profile_time
      ON de_follow_up_records (user_id, profile_id, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_de_follow_up_records_task
      ON de_follow_up_records (task_id, occurred_at DESC)
      WHERE task_id IS NOT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_copy_projects (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            VARCHAR(100) NOT NULL,
      profile_id         UUID REFERENCES de_customer_profiles(id) ON DELETE SET NULL,
      name               VARCHAR(300) NOT NULL,
      objective          TEXT NOT NULL,
      brief              JSONB NOT NULL DEFAULT '{}'
                         CHECK (jsonb_typeof(brief) = 'object'),
      selected_draft_id  UUID,
      status             VARCHAR(16) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'completed', 'archived')),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_de_copy_projects_user_status_updated
      ON de_copy_projects (user_id, status, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_de_copy_projects_profile
      ON de_copy_projects (user_id, profile_id, updated_at DESC)
      WHERE profile_id IS NOT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_copy_generation_runs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           VARCHAR(100) NOT NULL,
      project_id        UUID NOT NULL REFERENCES de_copy_projects(id) ON DELETE CASCADE,
      idempotency_key   VARCHAR(200) NOT NULL,
      model_id          VARCHAR(160) NOT NULL,
      brief_snapshot    JSONB NOT NULL CHECK (jsonb_typeof(brief_snapshot) = 'object'),
      profile_snapshot  JSONB NOT NULL DEFAULT '{}'
                        CHECK (jsonb_typeof(profile_snapshot) = 'object'),
      prompt_version    VARCHAR(80) NOT NULL,
      status            VARCHAR(16) NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'succeeded', 'failed')),
      error_code        VARCHAR(80),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at       TIMESTAMPTZ,
      UNIQUE (user_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_de_copy_runs_user_project_created
      ON de_copy_generation_runs (user_id, project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_de_copy_runs_status
      ON de_copy_generation_runs (status, created_at)
      WHERE status = 'running';
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS de_copy_drafts (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            VARCHAR(100) NOT NULL,
      project_id         UUID NOT NULL REFERENCES de_copy_projects(id) ON DELETE CASCADE,
      generation_run_id  UUID REFERENCES de_copy_generation_runs(id) ON DELETE SET NULL,
      parent_draft_id    UUID REFERENCES de_copy_drafts(id) ON DELETE SET NULL,
      variant_no         INTEGER NOT NULL DEFAULT 1 CHECK (variant_no > 0),
      source             VARCHAR(16) NOT NULL CHECK (source IN ('ai', 'manual')),
      title              VARCHAR(500),
      content            TEXT NOT NULL,
      metadata           JSONB NOT NULL DEFAULT '{}'
                         CHECK (jsonb_typeof(metadata) = 'object'),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_de_copy_drafts_user_project_created
      ON de_copy_drafts (user_id, project_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_de_copy_drafts_parent
      ON de_copy_drafts (parent_draft_id)
      WHERE parent_draft_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_de_copy_drafts_run_variant
      ON de_copy_drafts (generation_run_id, variant_no)
      WHERE generation_run_id IS NOT NULL;
  `);

  // de_copy_projects points at the chosen draft while every draft points at
  // its project. Add this side of the cyclic relationship after both tables
  // exist, with a named guard so the DDL remains safe when audited/replayed.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_de_copy_projects_selected_draft'
          AND conrelid = 'de_copy_projects'::regclass
      ) THEN
        ALTER TABLE de_copy_projects
          ADD CONSTRAINT fk_de_copy_projects_selected_draft
          FOREIGN KEY (selected_draft_id) REFERENCES de_copy_drafts(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);

  // Reuse the domain-wide updated_at function created by migration 0004.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_follow_up_suggestions_updated_at') THEN
        CREATE TRIGGER trg_de_follow_up_suggestions_updated_at
        BEFORE UPDATE ON de_follow_up_suggestions
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_follow_up_tasks_updated_at') THEN
        CREATE TRIGGER trg_de_follow_up_tasks_updated_at
        BEFORE UPDATE ON de_follow_up_tasks
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_follow_up_settings_updated_at') THEN
        CREATE TRIGGER trg_de_follow_up_settings_updated_at
        BEFORE UPDATE ON de_follow_up_automation_settings
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_copy_projects_updated_at') THEN
        CREATE TRIGGER trg_de_copy_projects_updated_at
        BEFORE UPDATE ON de_copy_projects
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_de_copy_drafts_updated_at') THEN
        CREATE TRIGGER trg_de_copy_drafts_updated_at
        BEFORE UPDATE ON de_copy_drafts
        FOR EACH ROW EXECUTE FUNCTION de_set_updated_at();
      END IF;
    END $$;
  `);
}

export const digitalEmployeeFollowUpCopy: Migration = {
  version: 10,
  name: "digital-employee-follow-up-copy",
  up,
};
