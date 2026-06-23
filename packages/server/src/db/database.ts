import pg from "pg";

export interface Conversation {
  id: string;
  title: string;
  model: string | null;
  provider: string | null;
  system_prompt: string | null;
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
          status      VARCHAR(20) NOT NULL DEFAULT 'active',
          metadata    JSONB       NOT NULL DEFAULT '{}',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
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

      await client.query("COMMIT");
      console.log("Database migration complete");
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
    provider?: string
  ): Promise<Conversation> {
    const { rows } = await this.pool.query(
      `INSERT INTO conversations (id, title, model, provider)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, title, model ?? null, provider ?? null]
    );
    return rows[0];
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM conversations WHERE id = $1",
      [id]
    );
    return rows[0] ?? null;
  }

  async listConversations(): Promise<Conversation[]> {
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
