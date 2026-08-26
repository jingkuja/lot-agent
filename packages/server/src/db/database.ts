import pg from "pg";
import {
  DEFAULT_INSTALLED_AGENT_IDS,
  GENERAL_AGENT_ID,
  nextSortOrder,
  promotedSortOrder,
} from "../agents/install-order.js";
import { normalizeApiKeyEntries, type RawApiKeyEntry } from "../tokenhub/api-key-entry.js";
import { SecretBox, createSecretBox, sha256Hex } from "../auth/secret-box.js";
import { runMigrations } from "./migration-runner.js";
import { migrations } from "./migrations/index.js";
import { maskPhone } from "./phone.js";

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
  /** Conversation-scoped, monotonically increasing order key (report #20).
   * BIGINT — pg returns it as a string, converted to number in getMessages. */
  seq: number;
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
  stage: string | null;
  attempts: number;
  input: unknown;
  output: unknown | null;
  error: string | null;
  vendor_task_id: string | null;
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
  original_name: string | null;
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
  email: string | null;
  name: string | null;
  created_at: string;
  external_user_id?: number | null;
  username?: string | null;
  /** Display-safe phone value; the raw number is never persisted locally. */
  phone?: string | null;
  api_key?: string | null;
  api_keys?: (RawApiKeyEntry | string)[] | null;
  managed_token_id?: number | null;
  managed_api_key?: string | null;
  credential_version?: number;
  managed_key_status?: string | null;
  managed_key_provisioned_at?: string | null;
}

export interface UserBalance {
  user_id: string;
  balance: number;
  daily_limit: number | null;
  monthly_limit: number | null;
  created_at: string;
  updated_at: string;
}

export interface StoredReviewLog {
  id: string;
  user_id: string;
  task_id: string | null;
  content_type: string;
  verdict: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface StoredPlatformAccount {
  id: string;
  user_id: string;
  platform: string;
  access_token: string;
  expires_at: string | null;
  created_at: string;
}

export interface StoredPublishRecord {
  id: string;
  user_id: string;
  platform: string;
  title: string | null;
  status: string;
  published_url: string | null;
  created_at: string;
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

function parsePgBigInt(value: number | string, column: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid ${column} returned by PostgreSQL`);
  }
  return parsed;
}

export class DB {
  readonly pool: pg.Pool;
  private readonly secretBox: SecretBox;

  /**
   * `secretBox` defaults to `createSecretBox()` (reads `SECRET_MASTER_KEY`
   * from the environment) so both the server and worker process — which
   * construct `DB` independently but share the same env — encrypt/decrypt
   * consistently with zero extra wiring. Tests that don't care about
   * encryption can pass an explicit passthrough `new SecretBox(undefined)`
   * to avoid depending on env state.
   */
  constructor(config?: Partial<DBConfig>, secretBox: SecretBox = createSecretBox()) {
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
    this.secretBox = secretBox;
  }

  /** Normalizes/decrypts a user row in place (mutates and returns `row`).
   * PostgreSQL BIGINT values are strings in `pg`; convert the user/token ids
   * here so callers do not accidentally serialize them as JSON strings.
   * Single choke point so every read path (getUserById, upsertUserByExternalId, …)
   * returns normalized plaintext consistently. */
  private openUserRow<T extends {
    external_user_id?: number | string | null;
    managed_token_id?: number | string | null;
    api_key?: string | null;
    api_keys?: unknown;
    managed_api_key?: string | null;
  }>(row: T): T {
    if (row.external_user_id != null) {
      row.external_user_id = parsePgBigInt(row.external_user_id, "external_user_id") as T["external_user_id"];
    }
    if (row.managed_token_id != null) {
      row.managed_token_id = parsePgBigInt(row.managed_token_id, "managed_token_id") as T["managed_token_id"];
    }
    if (row.api_key) {
      row.api_key = this.secretBox.open(row.api_key) as T["api_key"];
    }
    if (Array.isArray(row.api_keys)) {
      row.api_keys = normalizeApiKeyEntries(row.api_keys).map((e) => ({
        ...e,
        apiKey: this.secretBox.open(e.apiKey),
      })) as T["api_keys"];
    }
    if (row.managed_api_key) {
      row.managed_api_key = this.secretBox.open(row.managed_api_key) as T["managed_api_key"];
    }
    return row;
  }

  /**
   * Run idempotent schema migrations. Owned by the SERVER process ONLY — the
   * worker must not call this (see workers/index.ts). Keeping a single migration
   * owner avoids two containers issuing concurrent DDL on startup, and means a
   * worker never depends on / waits for the server to finish migrating: it just
   * uses the pool created in the constructor.
   */
  async migrate(): Promise<void> {
    await runMigrations(this.pool, migrations);

    // Keep the physical schema as the source of truth during rolling upgrades.
    // A previous deployment can have recorded migration 19 while its DDL was
    // interrupted or applied to a different database; managed login writes
    // this column, so repair that drift before the server accepts requests.
    await this.pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32)
    `);
  }

  // ── Conversations ──

  async createConversation(
    id: string,
    title: string,
    model?: string,
    provider?: string,
    agentId?: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): Promise<Conversation> {
    const { rows } = await this.pool.query(
      `INSERT INTO conversations (id, title, model, provider, agent_id, user_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [id, title, model ?? null, provider ?? null, agentId ?? "general", userId ?? "default", JSON.stringify(metadata ?? {})]
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

  async listConversations(
    userId?: string,
    opts?: { limit?: number; cursorId?: string }
  ): Promise<Conversation[]> {
    // Keyset pagination over (updated_at DESC, id DESC). Omitting `limit`
    // returns the full list (back-compat for non-paginated callers); the id
    // tiebreaker keeps the order stable across pages.
    const hasPaging = opts?.limit != null;
    const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 0), 1), 100);

    const params: unknown[] = [];
    const where: string[] = ["status = 'active'"];
    // Exclude empty shells (0-message conversations, e.g. a chat that was
    // created but whose first send never persisted, or seed rows). They render
    // identically to a brand-new chat, so surfacing one as the "latest"
    // conversation makes the workspace look like it always opens a new chat.
    where.push(
      "EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)"
    );
    if (userId) {
      params.push(userId);
      where.push(`user_id = $${params.length}`);
    }
    if (hasPaging && opts?.cursorId) {
      params.push(opts.cursorId);
      // The subquery reads the cursor row's exact stored timestamp, so the
      // cursor never loses precision the way a client-supplied timestamp would.
      // A deleted cursor row yields NULL → an empty page (self-heals on refresh).
      where.push(
        `(updated_at, id) < (SELECT updated_at, id FROM conversations WHERE id = $${params.length})`
      );
    }

    let sql = `SELECT * FROM conversations WHERE ${where.join(
      " AND "
    )} ORDER BY updated_at DESC, id DESC`;
    if (hasPaging) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE conversations SET status = 'deleted' WHERE id = $1",
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  /** Shallow-merge keys into a conversation's metadata JSONB. */
  async mergeConversationMetadata(
    id: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      "UPDATE conversations SET metadata = metadata || $1::jsonb WHERE id = $2",
      [JSON.stringify(patch), id]
    );
  }

  async getConversationCustomerContext(
    id: string,
    userId: string
  ): Promise<{ id: string; displayName: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT metadata->'digitalEmployeeCurrentProfile' AS context
       FROM conversations WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId]
    );
    const value = rows[0]?.context;
    if (!value || typeof value !== "object") return null;
    const profileId = (value as Record<string, unknown>).id;
    const displayName = (value as Record<string, unknown>).displayName;
    return typeof profileId === "string" && typeof displayName === "string"
      ? { id: profileId, displayName }
      : null;
  }

  async setConversationCustomerContext(
    id: string,
    userId: string,
    profile: { id: string; displayName: string } | null
  ): Promise<boolean> {
    const { rowCount } = profile
      ? await this.pool.query(
          `UPDATE conversations
           SET metadata = metadata || jsonb_build_object('digitalEmployeeCurrentProfile', $1::jsonb)
           WHERE id = $2 AND user_id = $3 AND status = 'active'`,
          [JSON.stringify(profile), id, userId]
        )
      : await this.pool.query(
          `UPDATE conversations SET metadata = metadata - 'digitalEmployeeCurrentProfile'
           WHERE id = $1 AND user_id = $2 AND status = 'active'`,
          [id, userId]
        );
    return (rowCount ?? 0) > 0;
  }

  async updateConversationTitle(id: string, title: string): Promise<void> {
    await this.pool.query(
      "UPDATE conversations SET title = $1 WHERE id = $2",
      [title, id]
    );
  }

  /** Persist the per-conversation selected model (reuses the `model` column). */
  async setConversationModel(id: string, modelId: string): Promise<void> {
    await this.pool.query(
      "UPDATE conversations SET model = $1 WHERE id = $2",
      [modelId, id]
    );
  }

  /**
   * Atomic run-lease claim (report #20 concurrency half / architecture #10).
   * Two tabs/devices sending into the same conversation at once must not both
   * start a turn — this is a plain CAS, not a queue: a caller that loses the
   * race gets `false` back and the route turns that into an immediate 409,
   * it never waits/retries.
   *
   * Succeeds (claims the lease) when the conversation has no active run, OR
   * its existing lease is older than `staleMs`. The staleness branch exists
   * purely as a crash/hang fallback for a holder process that died mid-turn
   * without reaching its `finally`/release — a live request never needs it,
   * since nothing refreshes `run_started_at` mid-stream. Returns whether THIS
   * call won the claim (`false` also covers an unknown conversationId).
   */
  async claimConversationRun(
    conversationId: string,
    runId: string,
    staleMs: number
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE conversations
       SET active_run_id = $2, run_started_at = now()
       WHERE id = $1
         AND (active_run_id IS NULL OR run_started_at < now() - make_interval(secs => $3::double precision / 1000.0))`,
      [conversationId, runId, staleMs]
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Fencing release: only clears the lease when it still belongs to `runId`.
   * Without this check, a holder that hung long enough for its lease to go
   * stale — and get reclaimed by a newer run — would clobber that newer run's
   * ownership when it finally reaches its own (late) release.
   */
  async releaseConversationRun(conversationId: string, runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversations SET active_run_id = NULL, run_started_at = NULL
       WHERE id = $1 AND active_run_id = $2`,
      [conversationId, runId]
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
      /** Row status; generation messages are born 'generating' so no separate
       * status write (and its race window) is needed after insert. */
      status?: string;
    } = {}
  ): Promise<void> {
    // seq is allocated atomically via the `alloc` CTE: the UPDATE takes a row
    // lock on the owning conversation, so concurrent inserts into the same
    // conversation serialize on that lock and each gets a distinct,
    // gap-free-per-writer next_seq (report #20). If the conversation row
    // doesn't exist, `alloc` returns zero rows and the INSERT...SELECT
    // inserts zero rows — stricter than the previous behavior (which would
    // have silently inserted an orphaned message), and acceptable since a
    // conversation_id with no owning row is already a caller bug.
    await this.pool.query(
      `WITH alloc AS (
         UPDATE conversations SET next_seq = next_seq + 1 WHERE id = $2 RETURNING next_seq
       )
       INSERT INTO messages (id, conversation_id, role, content, tool_call_id, token_count, model, latency_ms, metadata, status, seq)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, alloc.next_seq FROM alloc`,
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
        options.status ?? "completed",
      ]
    );
  }

  /**
   * Patch a generation message's status + metadata (used by the worker).
   * The update is scoped to the owning conversation AND user: a message id
   * alone is client-forgeable job input, so an id pointing at another user's
   * message must update zero rows.
   */
  async updateMessageGeneration(
    messageId: string,
    patch: { status: string; metadata: Record<string, unknown> },
    owner: { conversationId: string; userId: string }
  ): Promise<void> {
    // `m.status = 'generating'` makes the transition one-way: once a worker
    // has written completed/failed/cancelled, a slower writer (e.g. the
    // route's post-enqueue taskId write racing a cache-hit completion) can't
    // drag the message back to 'generating' and drop its assets.
    await this.pool.query(
      `UPDATE messages m SET status = $1, metadata = $2
       FROM conversations c
       WHERE m.id = $3
         AND m.conversation_id = $4
         AND c.id = m.conversation_id
         AND c.user_id = $5
         AND m.status = 'generating'`,
      [patch.status, JSON.stringify(patch.metadata), messageId, owner.conversationId, owner.userId]
    );
  }

  /**
   * Flip a generation message to 'cancelled' without touching the rest of its
   * metadata (prompt/settings keep rendering the card). Same ownership scope
   * and one-way guard as updateMessageGeneration.
   */
  async markMessageGenerationCancelled(
    messageId: string,
    owner: { conversationId: string; userId: string }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE messages m
       SET status = 'cancelled', metadata = m.metadata || '{"status":"cancelled"}'::jsonb
       FROM conversations c
       WHERE m.id = $1
         AND m.conversation_id = $2
         AND c.id = m.conversation_id
         AND c.user_id = $3
         AND m.status = 'generating'`,
      [messageId, owner.conversationId, owner.userId]
    );
  }

  /**
   * Flip a generation message to 'failed' with an error, merging into (not
   * replacing) the existing metadata so the card's kind/mediaType/prompt keep
   * rendering and the error shows on hover. Same ownership scope and one-way
   * ('generating' only) guard as markMessageGenerationCancelled. Used by the
   * stale-task reaper when a job is never claimed by a worker.
   */
  async markMessageGenerationFailed(
    messageId: string,
    error: string,
    owner: { conversationId: string; userId: string }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE messages m
       SET status = 'failed',
           metadata = COALESCE(m.metadata, '{}'::jsonb)
             || jsonb_build_object('status', 'failed', 'error', $4::text)
       FROM conversations c
       WHERE m.id = $1
         AND m.conversation_id = $2
         AND c.id = m.conversation_id
         AND c.user_id = $3
         AND m.status = 'generating'`,
      [messageId, owner.conversationId, owner.userId, error]
    );
  }

  /**
   * Read a generation message's status + parsed metadata, scoped to its owner.
   * Used by the download-retry route to recover the persisted `sourceUrl`
   * (and settings) of a generation left in 'download_failed'. Returns null if
   * the message doesn't exist or isn't owned by `userId`.
   */
  async getGenerationMessage(
    messageId: string,
    conversationId: string,
    userId: string
  ): Promise<{ status: string; metadata: Record<string, unknown> } | null> {
    const { rows } = await this.pool.query(
      `SELECT m.status, m.metadata
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND m.conversation_id = $2 AND c.user_id = $3`,
      [messageId, conversationId, userId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const metadata =
      typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata ?? {});
    return { status: r.status, metadata };
  }

  /**
   * Reopen a 'download_failed' generation message for a download-only retry:
   * flip it back to 'generating' so the retry worker's finalize (guarded on
   * 'generating') can land 'completed'. Guarded on the current status being
   * exactly 'download_failed' so a double-click / concurrent retry only ever
   * enqueues one job. Returns whether the transition happened.
   */
  async resetGenerationForRedownload(
    messageId: string,
    owner: { conversationId: string; userId: string }
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE messages m
       SET status = 'generating',
           metadata = COALESCE(m.metadata, '{}'::jsonb) || '{"status":"generating"}'::jsonb
       FROM conversations c
       WHERE m.id = $1
         AND m.conversation_id = $2
         AND c.id = m.conversation_id
         AND c.user_id = $3
         AND m.status = 'download_failed'`,
      [messageId, owner.conversationId, owner.userId]
    );
    return (rowCount ?? 0) > 0;
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    // NULLS FIRST is pure defense: every row should have a non-null seq after
    // the 0002 migration's backfill + the atomic allocation in addMessage.
    // created_at stays as the tiebreaker for defense-in-depth, not because
    // seq can actually collide within a conversation (idx_messages_conv_seq
    // enforces uniqueness).
    const { rows } = await this.pool.query(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY seq ASC NULLS FIRST, created_at ASC",
      [conversationId]
    );
    // seq is BIGINT — pg returns it as a string; convert so callers get a number.
    return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
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

  /**
   * Delete the given message and all messages after it (by seq), scoped to
   * `conversationId`. The boundary subquery is ALSO scoped to
   * `conversationId` — otherwise a `messageId` from a different conversation
   * would smuggle in that conversation's seq as the deletion boundary
   * (deleting the caller's own messages based on someone else's message
   * ordering). Uses `seq` rather than `created_at` (report #20) since seq is
   * the stable, gap-free-per-conversation order key; created_at ties within
   * the same conversation are exactly what seq exists to disambiguate.
   * Returns whether the boundary message existed in this conversation (it
   * deletes itself too, so a hit is always >= 1 row).
   */
  async deleteMessagesFromAndAfter(conversationId: string, messageId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM messages
       WHERE conversation_id = $1
         AND seq >= (
           SELECT seq FROM messages WHERE id = $2 AND conversation_id = $1
         )`,
      [conversationId, messageId]
    );
    return (rowCount ?? 0) > 0;
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

  /**
   * Resolve a message's ownership chain (message → conversation → user).
   * Returns null for an unknown message; used by routes to collapse
   * cross-user access to 404.
   */
  async getMessageOwner(
    messageId: string
  ): Promise<{ conversationId: string; userId: string | null } | null> {
    const { rows } = await this.pool.query(
      `SELECT m.conversation_id, c.user_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1`,
      [messageId]
    );
    if (!rows[0]) return null;
    return { conversationId: rows[0].conversation_id, userId: rows[0].user_id ?? null };
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
    originalName?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO assets (id, task_id, user_id, type, storage_key, url, mime, size_bytes, width, height, duration_sec, original_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
        a.originalName ?? null,
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

  async listUserUploads(userId: string): Promise<StoredAsset[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM assets WHERE user_id = $1 AND type = 'upload' ORDER BY created_at DESC, id DESC",
      [userId]
    );
    return rows;
  }

  async deleteUserUpload(id: string, userId: string): Promise<StoredAsset | null> {
    const { rows } = await this.pool.query(
      "DELETE FROM assets WHERE id = $1 AND user_id = $2 AND type = 'upload' RETURNING *",
      [id, userId]
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
    return rows[0] ? this.openUserRow(rows[0]) : null;
  }

  async upsertUserByExternalId(args: {
    externalUserId: number;
    username: string;
    apiKeys: RawApiKeyEntry[];
  }): Promise<StoredUser> {
    const activePlain = args.apiKeys[0]?.apiKey ?? null;
    const active = activePlain ? this.secretBox.seal(activePlain) : null;
    const sealedKeys = args.apiKeys.map((k) => ({ ...k, apiKey: this.secretBox.seal(k.apiKey) }));
    const { rows } = await this.pool.query(
      `INSERT INTO users (external_user_id, username, name, api_key, api_keys, email)
         VALUES ($1, $2, $2, $3, $4, $5)
       ON CONFLICT (external_user_id)
         DO UPDATE SET username = $2, api_key = $3, api_keys = $4
       RETURNING *`,
      [args.externalUserId, args.username, active, JSON.stringify(sealedKeys), `${args.username}@tokenhub.local`]
    );
    return this.openUserRow(rows[0]);
  }

  async upsertManagedUser(args: {
    externalUserId: number;
    username: string;
    name: string;
    phone?: string | null;
    tokenId: number;
    apiKey: string;
    credentialVersion: number;
    status?: string;
  }): Promise<StoredUser> {
    const sealedManagedKey = this.secretBox.seal(args.apiKey);
    const { rows } = await this.pool.query(
      `INSERT INTO users (
         external_user_id, username, name, email, phone, managed_token_id,
         managed_api_key, credential_version, managed_key_status, managed_key_provisioned_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (external_user_id) DO UPDATE SET
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         phone = COALESCE(EXCLUDED.phone, users.phone),
         managed_token_id = EXCLUDED.managed_token_id,
         managed_api_key = EXCLUDED.managed_api_key,
         credential_version = EXCLUDED.credential_version,
         managed_key_status = EXCLUDED.managed_key_status,
         managed_key_provisioned_at = now()
       RETURNING *`,
      [
        args.externalUserId,
        args.username,
        args.name,
        `${args.username}@tokenhub.local`,
        maskPhone(args.phone),
        args.tokenId,
        sealedManagedKey,
        args.credentialVersion,
        args.status ?? "active",
      ]
    );
    return this.openUserRow(rows[0]);
  }

  async updateUserPhone(id: string, phone: string): Promise<StoredUser | null> {
    const { rows } = await this.pool.query(
      "UPDATE users SET phone = $2 WHERE id = $1 RETURNING *",
      [id, maskPhone(phone)]
    );
    return rows[0] ? this.openUserRow(rows[0]) : null;
  }

  async getUserApiKey(userId: string, managedOnly = false): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT managed_api_key, api_key FROM users WHERE id = $1",
      [userId]
    );
    const raw = rows[0]?.managed_api_key ?? (managedOnly ? null : rows[0]?.api_key) ?? null;
    return raw ? this.secretBox.open(raw) : null;
  }

  async getUserRuntimeApiKeys(userId: string, managedOnly = false): Promise<RawApiKeyEntry[]> {
    const { rows } = await this.pool.query(
      "SELECT managed_api_key, api_keys FROM users WHERE id = $1",
      [userId]
    );
    const managed = rows[0]?.managed_api_key as string | null | undefined;
    if (managed) {
      return [{ apiKey: this.secretBox.open(managed), name: "Lot Agent 托管订阅" }];
    }
    if (managedOnly) return [];
    return normalizeApiKeyEntries(rows[0]?.api_keys).map((entry) => ({
      ...entry,
      apiKey: this.secretBox.open(entry.apiKey),
    }));
  }

  async getUserApiKeys(userId: string): Promise<RawApiKeyEntry[]> {
    const { rows } = await this.pool.query(
      "SELECT api_keys FROM users WHERE id = $1",
      [userId]
    );
    return normalizeApiKeyEntries(rows[0]?.api_keys).map((e) => ({
      ...e,
      apiKey: this.secretBox.open(e.apiKey),
    }));
  }

  /** Sets the single per-user active key (`users.api_key`); shared across all of that
   * account's concurrent sessions, not per-session. */
  async setActiveApiKey(userId: string, index: number): Promise<string> {
    const keys = await this.getUserApiKeys(userId); // already plaintext (decrypted above)
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
      throw new Error("index_out_of_range");
    }
    const active = keys[index].apiKey;
    await this.pool.query("UPDATE users SET api_key = $1 WHERE id = $2", [
      this.secretBox.seal(active),
      userId,
    ]);
    return active;
  }

  // ── Sessions ──

  /**
   * Stores only `sha256(token)` (see report #15) — the raw token never
   * touches the DB. `session-store.ts` still hands us/receives the raw
   * token; hashing is entirely internal to this class.
   */
  async createSession(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [userId, sha256Hex(token), expiresAt.toISOString()]
    );
  }

  async getSessionByToken(token: string): Promise<{ user_id: string; expires_at: string } | null> {
    const { rows } = await this.pool.query(
      "SELECT user_id, expires_at FROM sessions WHERE token_hash = $1",
      [sha256Hex(token)]
    );
    return rows[0] ?? null;
  }

  async touchSession(token: string): Promise<void> {
    await this.pool.query(
      "UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1",
      [sha256Hex(token)]
    );
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256Hex(token)]);
  }

  /**
   * Sweep hard-expired session rows (#16). `SessionStore.resolve` already
   * treats an expired row as invalid via `token_hash` lookup, so these rows
   * are pure dead weight — nothing else reads them. Sliding renewal / device
   * management are explicitly out of scope (product decision per the review
   * report), this is cleanup only. Returns the number of rows removed.
   */
  async deleteExpiredSessions(): Promise<number> {
    const { rowCount } = await this.pool.query("DELETE FROM sessions WHERE expires_at < now()");
    return rowCount ?? 0;
  }

  // ── Review Logs ──

  async writeReviewLog(r: {
    userId: string;
    taskId?: string | null;
    contentType: string;
    verdict: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO review_logs (user_id, task_id, content_type, verdict, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [r.userId, r.taskId ?? null, r.contentType, r.verdict, JSON.stringify(r.detail)]
    );
  }

  // ── Platform Accounts ──

  async upsertPlatformAccount(a: {
    userId: string;
    platform: string;
    accessToken: string;
    expiresAt?: Date | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_accounts (user_id, platform, access_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, platform) DO UPDATE SET access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at`,
      [a.userId, a.platform, this.secretBox.seal(a.accessToken), a.expiresAt ?? null]
    );
  }

  async getPlatformAccount(userId: string, platform: string): Promise<StoredPlatformAccount | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM platform_accounts WHERE user_id = $1 AND platform = $2",
      [userId, platform]
    );
    if (!rows[0]) return null;
    return { ...rows[0], access_token: this.secretBox.open(rows[0].access_token) };
  }

  // ── Publish Records ──

  async createPublishRecord(p: {
    userId: string;
    platform: string;
    title: string;
    status: string;
    publishedUrl: string;
  }): Promise<StoredPublishRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO publish_records (user_id, platform, title, status, published_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [p.userId, p.platform, p.title, p.status, p.publishedUrl]
    );
    return rows[0];
  }

  async getPublishRecords(userId: string, limit = 100): Promise<StoredPublishRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM publish_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
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

  async getTotalSpend(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(total_cost), 0) AS total
       FROM usage_logs WHERE user_id = $1`,
      [userId]
    );
    return Number(rows[0].total);
  }

  // ── User agents (Agent 中心) ──

  async getUserAgents(userId: string): Promise<Map<string, number>> {
    const read = async () =>
      (
        await this.pool.query(
          `SELECT agent_id, sort_order FROM user_agents
           WHERE user_id = $1 ORDER BY sort_order ASC`,
          [userId]
        )
      ).rows;

    let rows = await read();
    if (rows.length === 0) {
      // 懒播种默认安装集(digital employee/image/video),sort_order 按数组下标。
      for (let i = 0; i < DEFAULT_INSTALLED_AGENT_IDS.length; i++) {
        await this.pool.query(
          `INSERT INTO user_agents (user_id, agent_id, sort_order) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, agent_id) DO NOTHING`,
          [userId, DEFAULT_INSTALLED_AGENT_IDS[i], i]
        );
      }
      rows = await read();
    }
    return new Map(rows.map((r) => [r.agent_id as string, Number(r.sort_order)]));
  }

  async installUserAgent(userId: string, agentId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT sort_order FROM user_agents WHERE user_id = $1`,
      [userId]
    );
    const order = nextSortOrder(rows.map((r) => Number(r.sort_order)));
    await this.pool.query(
      `INSERT INTO user_agents (user_id, agent_id, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, agent_id) DO NOTHING`,
      [userId, agentId, order]
    );
  }

  async uninstallUserAgent(userId: string, agentId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM user_agents WHERE user_id = $1 AND agent_id = $2`,
      [userId, agentId]
    );
  }

  async promoteUserAgent(userId: string, agentId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT sort_order FROM user_agents WHERE user_id = $1 AND agent_id <> $2`,
      [userId, GENERAL_AGENT_ID]
    );
    const order = promotedSortOrder(rows.map((r) => Number(r.sort_order)));
    await this.pool.query(
      `UPDATE user_agents SET sort_order = $3 WHERE user_id = $1 AND agent_id = $2`,
      [userId, agentId, order]
    );
  }

  async isUserAgentInstalled(userId: string, agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM user_agents WHERE user_id = $1 AND agent_id = $2`,
      [userId, agentId]
    );
    return rows.length > 0;
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

  /**
   * Mark a task running and record which attempt this is (jobs v2 retries).
   * Guarded so a cancelled/succeeded task can't be resurrected (a cancel can
   * race the queue handing the job to a worker); 'failed' stays claimable for
   * BullMQ retries. Returns whether the task was actually claimed — a false
   * means the worker must skip execution.
   */
  async markTaskRunning(id: string, attempts: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE tasks SET status = 'running', attempts = $2, updated_at = now()
       WHERE id = $1 AND status IN ('pending','running','failed')`,
      [id, attempts]
    );
    return (rowCount ?? 0) > 0;
  }

  /** Current status of a task row (workers poll this to observe cross-process cancellation). */
  async getTaskStatus(id: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT status FROM tasks WHERE id = $1",
      [id]
    );
    return rows[0]?.status ?? null;
  }

  /** Cancel a task if it hasn't already reached a terminal state. Returns whether a row changed. */
  async cancelTask(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE tasks SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('pending','running')",
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  async getTaskVendorId(id: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT vendor_task_id FROM tasks WHERE id = $1",
      [id]
    );
    return rows[0]?.vendor_task_id ?? null;
  }

  /**
   * Fail generation tasks that were enqueued but **never claimed** by a worker
   * (`status = 'pending'` with `attempts = 0`) and are older than `staleMs`.
   * This is the safety net for a down/misconfigured worker (crashed on startup,
   * wrong Redis DB, not running): without it such tasks — and the "生成中" cards
   * bound to them — hang forever. `attempts = 0` scopes it to jobs a worker
   * never even started, so an in-flight (running) or retrying job is untouched.
   * Returns the failed rows so the caller can also fail the linked message.
   */
  async failStalePendingTasks(staleMs: number, error: string): Promise<StoredTask[]> {
    const { rows } = await this.pool.query(
      `UPDATE tasks SET status = 'failed', error = $2, updated_at = now()
       WHERE status = 'pending' AND attempts = 0
         AND created_at < now() - make_interval(secs => $1::double precision / 1000)
       RETURNING *`,
      [staleMs, error]
    );
    return rows as StoredTask[];
  }

  async setTaskVendorId(id: string, vendorTaskId: string): Promise<void> {
    await this.pool.query(
      "UPDATE tasks SET vendor_task_id = $1, updated_at = now() WHERE id = $2",
      [vendorTaskId, id]
    );
  }

  async updateTaskProgress(id: string, progress: number, stage?: string): Promise<void> {
    if (stage === undefined) {
      await this.pool.query(
        "UPDATE tasks SET progress = $1, updated_at = now() WHERE id = $2",
        [progress, id]
      );
    } else {
      await this.pool.query(
        "UPDATE tasks SET progress = $1, stage = $3, updated_at = now() WHERE id = $2",
        [progress, id, stage]
      );
    }
  }

  // Success/failure only apply to live tasks: 'cancelled' (and any other
  // terminal state) must survive a slower worker finishing after the cancel.
  async setTaskResult(id: string, output: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET output = $1, status = 'succeeded', progress = 100, updated_at = now()
       WHERE id = $2 AND status IN ('pending','running')`,
      [JSON.stringify(output), id]
    );
  }

  async setTaskError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET error = $1, status = 'failed', updated_at = now()
       WHERE id = $2 AND status IN ('pending','running')`,
      [error, id]
    );
  }
}
