import { sha256Hex } from "../../auth/secret-box.js";
import type { Migration, QueryClient } from "../migration-runner.js";

/**
 * Baseline migration: the entire schema that used to live in `DB.migrate()`
 * as ~400 lines of inline, hand-rolled-idempotent DDL/DML, transplanted
 * verbatim (statement-for-statement — nothing rewritten or "optimized",
 * these were already verified idempotent against production databases).
 *
 * The only change from the original `migrate()` body is mechanical: every
 * `this.pool.query(...)` becomes `client.query(...)` (the runner now owns
 * the connection + the single transaction wrapping this whole migration),
 * and the method's own `BEGIN`/`COMMIT`/`ROLLBACK`/`client.release()`
 * bookkeeping is gone because `runMigrations` provides that envelope.
 *
 * See B4-T3 report for the line-by-line diff against the pre-migration-runner
 * `migrate()` and the compatibility argument for existing databases.
 */
async function up(client: QueryClient): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  await client.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      title       VARCHAR(500) NOT NULL DEFAULT '新对话',
      model       VARCHAR(100),
      provider    VARCHAR(50),
      system_prompt TEXT,
      agent_id    VARCHAR(50) NOT NULL DEFAULT 'general',
      status      VARCHAR(20) NOT NULL DEFAULT 'active',
      metadata    JSONB       NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Idempotent migration: add agent_id to existing databases
  await client.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_id VARCHAR(50) NOT NULL DEFAULT 'general';
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_status_updated
      ON conversations (status, updated_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
      content         TEXT        NOT NULL DEFAULT '',
      tool_call_id    VARCHAR(100),
      token_count     INTEGER,
      model           VARCHAR(100),
      latency_ms      INTEGER,
      status          VARCHAR(20) NOT NULL DEFAULT 'completed',
      metadata        JSONB       NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages (conversation_id, created_at);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_tool_call_id
      ON messages (tool_call_id) WHERE tool_call_id IS NOT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS message_tool_calls (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id  UUID         NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tool_call_id VARCHAR(100) NOT NULL,
      tool_name   VARCHAR(200) NOT NULL,
      tool_input  JSONB        NOT NULL DEFAULT '{}',
      status      VARCHAR(20)  NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_calls_message
      ON message_tool_calls (message_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS message_ratings (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE UNIQUE,
      rating      SMALLINT    NOT NULL CHECK (rating IN (1, -1)),
      feedback    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ratings_message ON message_ratings (message_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_rating  ON message_ratings (rating);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS traces (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id  UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      model            VARCHAR(100),
      provider         VARCHAR(50),
      total_tokens     INTEGER     NOT NULL DEFAULT 0,
      total_latency_ms INTEGER,
      status           VARCHAR(20) NOT NULL DEFAULT 'ok',
      error_message    TEXT,
      metadata         JSONB       NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_traces_conversation
      ON traces (conversation_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS spans (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      trace_id        UUID        NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
      parent_span_id  UUID        REFERENCES spans(id) ON DELETE SET NULL,
      name            VARCHAR(100) NOT NULL,
      status          VARCHAR(20) NOT NULL DEFAULT 'ok',
      attributes      JSONB       NOT NULL DEFAULT '{}',
      events          JSONB       NOT NULL DEFAULT '[]',
      start_time      TIMESTAMPTZ NOT NULL,
      end_time        TIMESTAMPTZ
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans (trace_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_spans_name  ON spans (name);
  `);

  // Trigger for auto-updating conversations.updated_at
  await client.query(`
    CREATE OR REPLACE FUNCTION update_conversation_timestamp()
    RETURNS TRIGGER AS $$
    BEGIN
        UPDATE conversations SET updated_at = now() WHERE id = NEW.conversation_id;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Only create trigger if it doesn't exist
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_messages_updated_at'
      ) THEN
        CREATE TRIGGER trg_messages_updated_at
          AFTER INSERT ON messages
          FOR EACH ROW
          EXECUTE FUNCTION update_conversation_timestamp();
      END IF;
    END $$;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      type        VARCHAR(50)  NOT NULL,
      status      VARCHAR(20)  NOT NULL DEFAULT 'pending',
      progress    SMALLINT     NOT NULL DEFAULT 0,
      input       JSONB        NOT NULL DEFAULT '{}',
      output      JSONB,
      error       TEXT,
      user_id     VARCHAR(100) NOT NULL DEFAULT 'default',
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  // The vendor's own async task id (e.g. tokenhub "task_x6a2k…"), persisted
  // after create so a restarted worker can resume polling rather than
  // re-creating the generation. Distinct from our local tasks.id.
  await client.query(`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS vendor_task_id TEXT;
  `);

  // Jobs v2: attempt counter (retry accounting) + human-readable stage label.
  await client.query(`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attempts SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage TEXT;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id      UUID         REFERENCES tasks(id) ON DELETE SET NULL,
      user_id      VARCHAR(100) NOT NULL DEFAULT 'default',
      type         VARCHAR(20)  NOT NULL,
      storage_key  VARCHAR(500) NOT NULL,
      url          TEXT         NOT NULL,
      mime         VARCHAR(100) NOT NULL,
      size_bytes   INTEGER      NOT NULL DEFAULT 0,
      width        INTEGER,
      height       INTEGER,
      duration_sec NUMERIC,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_assets_task ON assets (task_id);
    CREATE INDEX IF NOT EXISTS idx_assets_user ON assets (user_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      VARCHAR(100)  NOT NULL DEFAULT 'default',
      task_id      UUID,
      model_id     VARCHAR(100)  NOT NULL,
      model_type   VARCHAR(20)   NOT NULL,
      input_count  INTEGER       NOT NULL DEFAULT 0,
      output_count INTEGER       NOT NULL DEFAULT 0,
      total_cost   NUMERIC(12,6) NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_logs (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_model_type ON usage_logs (model_type);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_balance (
      user_id       VARCHAR(100)  PRIMARY KEY,
      balance       NUMERIC(12,4) NOT NULL DEFAULT 0,
      daily_limit   NUMERIC(12,4),
      monthly_limit NUMERIC(12,4),
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
  `);

  // ── Users & Sessions (P6) ──

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      email      VARCHAR(255) UNIQUE NOT NULL,
      name       VARCHAR(255),
      created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS external_user_id BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_keys JSONB;
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external ON users (external_user_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token        VARCHAR(128) UNIQUE NOT NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ  NOT NULL,
      last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions (user_id);
  `);

  // Secret-at-rest hardening (report #15): sessions are looked up by a
  // SHA-256 digest of the token from here on; the raw token itself is no
  // longer persisted. `token` keeps its UNIQUE constraint (Postgres treats
  // multiple NULLs as distinct, so backfilled rows co-exist fine) but
  // drops NOT NULL so new rows can leave it NULL. Both statements are
  // idempotent/re-runnable.
  await client.query(`
    ALTER TABLE sessions ALTER COLUMN token DROP NOT NULL;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash TEXT;
  `);

  await client.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id VARCHAR(100) NOT NULL DEFAULT 'default';
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC);
  `);

  // Seed stable dev user
  await client.query(`
    INSERT INTO users (email, name) VALUES ('seed@local', 'Seed User')
      ON CONFLICT (email) DO NOTHING;
  `);

  // ── P7: Review & Publish tables ──

  await client.query(`
    CREATE TABLE IF NOT EXISTS review_logs (
      id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      VARCHAR(100) NOT NULL,
      task_id      UUID,
      content_type VARCHAR(20)  NOT NULL,
      verdict      VARCHAR(20)  NOT NULL,
      detail       JSONB        NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_review_user ON review_logs (user_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS platform_accounts (
      id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      VARCHAR(100) NOT NULL,
      platform     VARCHAR(50)  NOT NULL,
      access_token TEXT         NOT NULL,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      UNIQUE (user_id, platform)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS publish_records (
      id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       VARCHAR(100) NOT NULL,
      platform      VARCHAR(50)  NOT NULL,
      title         TEXT,
      status        VARCHAR(20)  NOT NULL DEFAULT 'published',
      published_url TEXT,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_publish_user ON publish_records (user_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_agents (
      user_id      VARCHAR(100)     NOT NULL,
      agent_id     VARCHAR(64)      NOT NULL,
      sort_order   DOUBLE PRECISION NOT NULL DEFAULT 0,
      installed_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, agent_id)
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents (user_id, sort_order);
  `);

  // Backfill legacy 'default' rows to the seed user (idempotent).
  const { rows: seedRows } = await client.query(
    "SELECT id FROM users WHERE email = 'seed@local'"
  );
  if (seedRows.length > 0) {
    const seedId = seedRows[0].id as string;
    await client.query(
      "UPDATE conversations SET user_id = $1 WHERE user_id = 'default'",
      [seedId]
    );
    await client.query(
      "UPDATE tasks SET user_id = $1 WHERE user_id = 'default'",
      [seedId]
    );
    await client.query(
      "UPDATE assets SET user_id = $1 WHERE user_id = 'default'",
      [seedId]
    );
    await client.query(
      "UPDATE usage_logs SET user_id = $1 WHERE user_id = 'default'",
      [seedId]
    );
    await client.query(
      "INSERT INTO user_balance (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [seedId]
    );
  }

  // Backfill: hash any still-plaintext session tokens into token_hash,
  // then null out the plaintext column. Idempotent — a row is only
  // selected while token_hash IS NULL, so a re-run touches zero rows.
  // Hashing happens in Node (sha256Hex), not pgcrypto, since that
  // extension isn't guaranteed available on every box.
  const { rows: legacySessions } = await client.query(
    "SELECT id, token FROM sessions WHERE token_hash IS NULL AND token IS NOT NULL"
  );
  for (const row of legacySessions) {
    await client.query(
      "UPDATE sessions SET token_hash = $1, token = NULL WHERE id = $2",
      [sha256Hex(row.token as string), row.id]
    );
  }

  // Created after the backfill so a pre-existing hash collision (should
  // never happen — sha256 of a 32-byte random token) can't block startup
  // before the backfill itself has a chance to run.
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash)"
  );

  console.log("Database migration complete");
}

export const baseline: Migration = {
  version: 1,
  name: "baseline",
  up,
};
