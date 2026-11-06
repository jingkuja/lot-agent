import type { Migration } from "../migration-runner.js";

/**
 * Work the owner hands to the digital employee. Every node, root or subtask, is one row with its own
 * hidden conversation, so nodes can run at the same time. State lives here rather than in a queue:
 * a task can wait days for the owner, and a queue's stalled retry could repeat a write.
 */
export const employeeAssignments: Migration = {
  version: 77, name: "employee-assignments",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS de_assignments (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         VARCHAR(100) NOT NULL,
        root_id         UUID NOT NULL REFERENCES de_assignments(id) ON DELETE CASCADE,
        position        INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        title           TEXT NOT NULL,
        goal            TEXT NOT NULL,
        mode            TEXT NOT NULL CHECK (mode IN ('autonomous', 'responsive')),
        status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
          'queued', 'running', 'succeeded', 'failed', 'waiting_user', 'waiting_team', 'waiting_children', 'cancelled', 'skipped'
        )),
        conversation_id UUID NOT NULL UNIQUE REFERENCES conversations(id),
        model_id        TEXT NOT NULL,
        created_by      TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner', 'employee')),
        result          JSONB,
        failure_reason  TEXT,
        end_intent      JSONB,
        retries_used    INTEGER NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
        auto_resumed    BOOLEAN NOT NULL DEFAULT false,
        not_before      TIMESTAMPTZ,
        web_searches    INTEGER NOT NULL DEFAULT 0 CHECK (web_searches >= 0),
        board_cursor    BIGINT NOT NULL DEFAULT 0,
        wait_for        JSONB,
        wait_until      TIMESTAMPTZ,
        tokens_used     BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        cost_used       NUMERIC(14, 6) NOT NULL DEFAULT 0 CHECK (cost_used >= 0),
        version         INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        lease_until     TIMESTAMPTZ,
        attachments     JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
        paused_reason   TEXT CHECK (paused_reason IN ('quota', 'cost_limit')),
        paused_at       TIMESTAMPTZ,
        cost_limit      NUMERIC(14, 6) CHECK (cost_limit > 0),
        subtask_limit   INTEGER CHECK (subtask_limit > 0),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at     TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_de_assignments_list ON de_assignments (user_id, created_at DESC, id DESC) WHERE id = root_id;
      CREATE INDEX IF NOT EXISTS idx_de_assignments_tree ON de_assignments (root_id, position);
      CREATE INDEX IF NOT EXISTS idx_de_assignments_claim ON de_assignments (created_at) WHERE status = 'queued';
      CREATE INDEX IF NOT EXISTS idx_de_assignments_running ON de_assignments (user_id, lease_until) WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS de_assignment_board (
        id         BIGSERIAL PRIMARY KEY,
        root_id    UUID NOT NULL REFERENCES de_assignments(id) ON DELETE CASCADE,
        user_id    VARCHAR(100) NOT NULL,
        author_id  UUID REFERENCES de_assignments(id) ON DELETE SET NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('summary', 'finding', 'output', 'alert', 'status')),
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        artifacts  JSONB NOT NULL DEFAULT '[]'::jsonb,
        to_ids     UUID[],
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_de_assignment_board_root ON de_assignment_board (root_id, id);

      CREATE TABLE IF NOT EXISTS de_assignment_runs (
        run_id        UUID PRIMARY KEY,
        assignment_id UUID NOT NULL REFERENCES de_assignments(id) ON DELETE CASCADE,
        user_id       VARCHAR(100) NOT NULL,
        made_progress BOOLEAN,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_de_assignment_runs_node ON de_assignment_runs (assignment_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS de_assignment_decisions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id UUID NOT NULL REFERENCES de_assignments(id) ON DELETE CASCADE,
        user_id       VARCHAR(100) NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('question', 'failure', 'quota')),
        question      TEXT NOT NULL,
        options       JSONB NOT NULL DEFAULT '[]'::jsonb,
        answer        TEXT,
        answered_via  TEXT,
        answered_at   TIMESTAMPTZ,
        feishu_message_id TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_de_assignment_decisions_open ON de_assignment_decisions (assignment_id) WHERE answered_at IS NULL;

      CREATE TABLE IF NOT EXISTS de_assignment_events (
        id                BIGSERIAL PRIMARY KEY,
        user_id           VARCHAR(100) NOT NULL,
        root_id           UUID NOT NULL REFERENCES de_assignments(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL CHECK (kind IN ('finished', 'paused', 'decision', 'reminder')),
        payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
        feishu_claimed_at TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_de_assignment_events_user ON de_assignment_events (user_id, id);
      CREATE INDEX IF NOT EXISTS idx_de_assignment_events_feishu ON de_assignment_events (id) WHERE feishu_claimed_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_tasks_source_conversation ON tasks ((input->>'sourceConversationId'))
        WHERE input ? 'sourceConversationId';
    `);
  },
};
