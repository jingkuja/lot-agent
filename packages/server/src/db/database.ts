import pg from "pg";

export interface Conversation {
  id: string;
  title: string;
  model: string | null;
  provider: string | null;
  system_prompt: string | null;
  agent_id: string;
  user_id: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  token_count: number | null;
  model: string | null;
  latency_ms: number | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface StoredToolCall {
  id: string;
  message_id: string;
  tool_call_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: string;
  created_at: string;
}

export interface MessageRating {
  id: string;
  message_id: string;
  rating: number;
  feedback: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredTrace {
  id: string;
  conversation_id: string;
  model: string | null;
  provider: string | null;
  total_tokens: number;
  total_latency_ms: number | null;
  status: string;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface StoredSpan {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  status: string;
  attributes: Record<string, unknown>;
  events: unknown[];
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
}

export interface StoredTask {
  id: string;
  type: string;
  status: string;
  progress: number;
  input: unknown;
  output: unknown | null;
  error: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface StoredAsset {
  id: string;
  task_id: string | null;
  user_id: string;
  type: string;
  storage_key: string;
  url: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  created_at: string;
}

export interface StoredUsageLog {
  id: string;
  user_id: string;
  task_id: string | null;
  model_id: string;
  model_type: string;
  input_count: number;
  output_count: number;
  total_cost: number;
  created_at: string;
}

export interface StoredUser {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
}

export interface UserBalance {
  user_id: string;
  balance: number;
  daily_limit: number | null;
  monthly_limit: number | null;
  created_at: string;
  updated_at: string;
}

export interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const DEFAULT_CONFIG: DBConfig = {
  host: "localhost",
  port: 5432,
  user: "postgres",
  // No default password — must be supplied via config
  password: "",
  database: "lot",
};

export class DB {
  readonly pool: pg.Pool;

  constructor(config?: Partial<DBConfig>) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.pool = new pg.Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async init(): Promise<void> {
    await this.migrate();
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
          title       VARCHAR(500) NOT NULL DEFAULT 'New Chat',
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

      await client.query("COMMIT");

      // Backfill legacy 'default' rows to the seed user (idempotent, outside transaction)
      const { rows: seedRows } = await this.pool.query(
        "SELECT id FROM users WHERE email = 'seed@local'"
      );
      if (seedRows.length > 0) {
        const seedId = seedRows[0].id as string;
        await this.pool.query(
          "UPDATE conversations SET user_id = $1 WHERE user_id = 'default'",
          [seedId]
        );
        await this.pool.query(
          "UPDATE tasks SET user_id = $1 WHERE user_id = 'default'",
          [seedId]
        );
        await this.pool.query(
          "UPDATE assets SET user_id = $1 WHERE user_id = 'default'",
          [seedId]
        );
        await this.pool.query(
          "UPDATE usage_logs SET user_id = $1 WHERE user_id = 'default'",
          [seedId]
        );
        await this.pool.query(
          "INSERT INTO user_balance (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [seedId]
        );
      }

      console.log("Database migration complete");
      return;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Conversations ──

  async createConversation(
    id: string,
    title: string,
    model?: string,
    provider?: string,
    agentId?: string,
    userId?: string
  ): Promise<Conversation> {
    const { rows } = await this.pool.query(
      `INSERT INTO conversations (id, title, model, provider, agent_id, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, title, model ?? null, provider ?? null, agentId ?? "general", userId ?? "default"]
    );
    return rows[0];
  }

  async getConversationAgentId(id: string): Promise<string> {
    const { rows } = await this.pool.query(
      "SELECT agent_id FROM conversations WHERE id = $1",
      [id]
    );
    return rows[0]?.agent_id ?? "general";
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM conversations WHERE id = $1",
      [id]
    );
    return rows[0] ?? null;
  }

  async listConversations(userId?: string): Promise<Conversation[]> {
    if (userId) {
      const { rows } = await this.pool.query(
        "SELECT * FROM conversations WHERE status = 'active' AND user_id = $1 ORDER BY updated_at DESC",
        [userId]
      );
      return rows;
    }
    const { rows } = await this.pool.query(
      "SELECT * FROM conversations WHERE status = 'active' ORDER BY updated_at DESC"
    );
    return rows;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE conversations SET status = 'deleted' WHERE id = $1",
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  async updateConversationTitle(id: string, title: string): Promise<void> {
    await this.pool.query(
      "UPDATE conversations SET title = $1 WHERE id = $2",
      [title, id]
    );
  }

  // ── Messages ──

  async addMessage(
    id: string,
    conversationId: string,
    role: string,
    content: string,
    options: {
      toolCallId?: string;
      tokenCount?: number;
      model?: string;
      latencyMs?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, conversation_id, role, content, tool_call_id, token_count, model, latency_ms, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        conversationId,
        role,
        content,
        options.toolCallId ?? null,
        options.tokenCount ?? null,
        options.model ?? null,
        options.latencyMs ?? null,
        JSON.stringify(options.metadata ?? {}),
      ]
    );
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows;
  }

  async getToolCallsForConversation(conversationId: string): Promise<Map<string, StoredToolCall[]>> {
    const { rows } = await this.pool.query(
      `SELECT tc.* FROM message_tool_calls tc
       JOIN messages m ON m.id = tc.message_id
       WHERE m.conversation_id = $1
       ORDER BY tc.created_at ASC`,
      [conversationId]
    );
    const map = new Map<string, StoredToolCall[]>();
    for (const row of rows) {
      const list = map.get(row.message_id) ?? [];
      list.push(row);
      map.set(row.message_id, list);
    }
    return map;
  }

  async deleteMessagesFromAndAfter(conversationId: string, messageId: string): Promise<void> {
    // Delete the given message and all messages created after it
    await this.pool.query(
      `DELETE FROM messages
       WHERE conversation_id = $1
         AND created_at >= (SELECT created_at FROM messages WHERE id = $2)`,
      [conversationId, messageId]
    );
  }

  async getRatingsForConversation(conversationId: string): Promise<Map<string, number>> {
    const { rows } = await this.pool.query(
      `SELECT mr.message_id, mr.rating
       FROM message_ratings mr
       JOIN messages m ON m.id = mr.message_id
       WHERE m.conversation_id = $1`,
      [conversationId]
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.message_id, row.rating);
    }
    return map;
  }

  // ── Tool Calls ──

  async addToolCall(
    messageId: string,
    toolCallId: string,
    toolName: string,
    toolInput: unknown
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO message_tool_calls (message_id, tool_call_id, tool_name, tool_input)
       VALUES ($1, $2, $3, $4)`,
      [messageId, toolCallId, toolName, JSON.stringify(toolInput)]
    );
  }

  async getToolCalls(messageId: string): Promise<StoredToolCall[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM message_tool_calls WHERE message_id = $1 ORDER BY created_at",
      [messageId]
    );
    return rows;
  }

  // ── Ratings ──

  async setRating(
    messageId: string,
    rating: number,
    feedback?: string
  ): Promise<MessageRating> {
    const { rows } = await this.pool.query(
      `INSERT INTO message_ratings (message_id, rating, feedback)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id) DO UPDATE SET rating = $2, feedback = $3, updated_at = now()
       RETURNING *`,
      [messageId, rating, feedback ?? null]
    );
    return rows[0];
  }

  async getRating(messageId: string): Promise<MessageRating | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM message_ratings WHERE message_id = $1",
      [messageId]
    );
    return rows[0] ?? null;
  }

  async removeRating(messageId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM message_ratings WHERE message_id = $1",
      [messageId]
    );
    return (rowCount ?? 0) > 0;
  }

  // ── Traces ──

  async addTrace(trace: {
    id: string;
    conversation_id: string;
    model?: string;
    provider?: string;
    total_tokens: number;
    total_latency_ms?: number;
    status: string;
    error_message?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO traces (id, conversation_id, model, provider, total_tokens, total_latency_ms, status, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        trace.id,
        trace.conversation_id,
        trace.model ?? null,
        trace.provider ?? null,
        trace.total_tokens,
        trace.total_latency_ms ?? null,
        trace.status,
        trace.error_message ?? null,
        JSON.stringify(trace.metadata ?? {}),
      ]
    );
  }

  async getTraces(conversationId?: string): Promise<StoredTrace[]> {
    if (conversationId) {
      const { rows } = await this.pool.query(
        "SELECT * FROM traces WHERE conversation_id = $1 ORDER BY created_at DESC",
        [conversationId]
      );
      return rows;
    }
    const { rows } = await this.pool.query(
      "SELECT * FROM traces ORDER BY created_at DESC LIMIT 50"
    );
    return rows;
  }

  async getTrace(traceId: string): Promise<StoredTrace | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM traces WHERE id = $1",
      [traceId]
    );
    return rows[0] ?? null;
  }

  // ── Spans ──

  async addSpan(span: {
    id: string;
    trace_id: string;
    parent_span_id?: string;
    name: string;
    status: string;
    attributes?: Record<string, unknown>;
    events?: unknown[];
    start_time: string;
    end_time?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO spans (id, trace_id, parent_span_id, name, status, attributes, events, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        span.id,
        span.trace_id,
        span.parent_span_id ?? null,
        span.name,
        span.status,
        JSON.stringify(span.attributes ?? {}),
        JSON.stringify(span.events ?? []),
        span.start_time,
        span.end_time ?? null,
      ]
    );
  }

  async getSpans(traceId: string): Promise<StoredSpan[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM spans WHERE trace_id = $1 ORDER BY start_time ASC",
      [traceId]
    );
    return rows;
  }

  // ── Assets ──

  async createAsset(a: {
    id: string;
    taskId?: string | null;
    userId: string;
    type: string;
    storageKey: string;
    url: string;
    mime: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
    durationSec?: number | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO assets (id, task_id, user_id, type, storage_key, url, mime, size_bytes, width, height, duration_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        a.id,
        a.taskId ?? null,
        a.userId,
        a.type,
        a.storageKey,
        a.url,
        a.mime,
        a.sizeBytes,
        a.width ?? null,
        a.height ?? null,
        a.durationSec ?? null,
      ]
    );
  }

  async getAsset(id: string): Promise<StoredAsset | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM assets WHERE id = $1",
      [id]
    );
    return rows[0] ?? null;
  }

  // ── Users ──

  async upsertUserByEmail(email: string, name?: string): Promise<StoredUser> {
    const { rows } = await this.pool.query(
      `INSERT INTO users (email, name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = COALESCE($2, users.name)
       RETURNING *`,
      [email, name ?? null]
    );
    return rows[0];
  }

  async getUserById(id: string): Promise<StoredUser | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM users WHERE id = $1",
      [id]
    );
    return rows[0] ?? null;
  }

  // ── Sessions ──

  async createSession(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userId, token, expiresAt.toISOString()]
    );
  }

  async getSessionByToken(token: string): Promise<{ user_id: string; expires_at: string } | null> {
    const { rows } = await this.pool.query(
      "SELECT user_id, expires_at FROM sessions WHERE token = $1",
      [token]
    );
    return rows[0] ?? null;
  }

  async touchSession(token: string): Promise<void> {
    await this.pool.query(
      "UPDATE sessions SET last_seen_at = now() WHERE token = $1",
      [token]
    );
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token = $1", [token]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── Usage Logs ──

  async writeUsageLog(u: {
    userId: string;
    taskId?: string | null;
    modelId: string;
    modelType: string;
    inputCount: number;
    outputCount: number;
    totalCost: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_logs (user_id, task_id, model_id, model_type, input_count, output_count, total_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        u.userId,
        u.taskId ?? null,
        u.modelId,
        u.modelType,
        u.inputCount,
        u.outputCount,
        u.totalCost,
      ]
    );
  }

  async getUsageLogs(userId: string, limit = 100): Promise<StoredUsageLog[]> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, task_id, model_id, model_type, input_count, output_count,
              total_cost::float8 AS total_cost, created_at
       FROM usage_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map((r) => ({
      ...r,
      total_cost: Number(r.total_cost),
    }));
  }

  async getUsageSummary(
    userId: string,
    by: "model_type" | "model" | "day"
  ): Promise<Array<{ key: string; total_cost: number; count: number }>> {
    let groupExpr: string;
    let keyExpr: string;
    if (by === "model_type") {
      groupExpr = "model_type";
      keyExpr = "model_type";
    } else if (by === "model") {
      groupExpr = "model_id";
      keyExpr = "model_id";
    } else {
      groupExpr = "date_trunc('day', created_at)::date";
      keyExpr = "date_trunc('day', created_at)::date::text";
    }
    const { rows } = await this.pool.query(
      `SELECT ${keyExpr} AS key, COALESCE(SUM(total_cost), 0) AS total_cost, COUNT(*) AS count
       FROM usage_logs WHERE user_id = $1 GROUP BY ${groupExpr} ORDER BY total_cost DESC`,
      [userId]
    );
    return rows.map((r) => ({
      key: String(r.key),
      total_cost: Number(r.total_cost),
      count: Number(r.count),
    }));
  }

  async ensureUserBalance(userId: string): Promise<UserBalance> {
    const { rows } = await this.pool.query(
      `INSERT INTO user_balance (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [userId]
    );
    const r = rows[0];
    return {
      user_id: r.user_id,
      balance: Number(r.balance),
      daily_limit: r.daily_limit != null ? Number(r.daily_limit) : null,
      monthly_limit: r.monthly_limit != null ? Number(r.monthly_limit) : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  async getDailySpend(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(total_cost), 0) AS total
       FROM usage_logs WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
      [userId]
    );
    return Number(rows[0].total);
  }

  async getMonthlySpend(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(total_cost), 0) AS total
       FROM usage_logs WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
      [userId]
    );
    return Number(rows[0].total);
  }

  // ── Tasks ──

  async createTask(
    id: string,
    type: string,
    input: unknown,
    userId: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO tasks (id, type, input, user_id)
       VALUES ($1, $2, $3, $4)`,
      [id, type, JSON.stringify(input), userId]
    );
  }

  async getTask(id: string): Promise<StoredTask | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM tasks WHERE id = $1",
      [id]
    );
    return rows[0] ?? null;
  }

  async updateTaskStatus(id: string, status: string): Promise<void> {
    await this.pool.query(
      "UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2",
      [status, id]
    );
  }

  async updateTaskProgress(id: string, progress: number): Promise<void> {
    await this.pool.query(
      "UPDATE tasks SET progress = $1, updated_at = now() WHERE id = $2",
      [progress, id]
    );
  }

  async setTaskResult(id: string, output: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET output = $1, status = 'succeeded', progress = 100, updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(output), id]
    );
  }

  async setTaskError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET error = $1, status = 'failed', updated_at = now()
       WHERE id = $2`,
      [error, id]
    );
  }
}
