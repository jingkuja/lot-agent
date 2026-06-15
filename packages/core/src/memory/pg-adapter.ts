import type { PersistentMemoryAdapter, MemoryEntry } from "./store.js";

/**
 * PostgreSQL adapter for user-level persistent memory.
 * Requires a `user_memory` table (auto-created by init()).
 */
export class PgMemoryAdapter implements PersistentMemoryAdapter {
  private pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

  constructor(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_memory (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     VARCHAR(200) NOT NULL DEFAULT 'default',
        key         VARCHAR(300) NOT NULL,
        value       TEXT NOT NULL,
        meta        JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(user_id, key)
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_user
        ON user_memory (user_id);
    `);
  }

  async get(userId: string, key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(
      "SELECT value FROM user_memory WHERE user_id = $1 AND key = $2",
      [userId, key]
    );
    return (rows[0] as { value: string } | undefined)?.value;
  }

  async set(userId: string, key: string, value: string, meta?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_memory (user_id, key, value, meta)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, key) DO UPDATE SET value = $3, meta = $4, updated_at = now()`,
      [userId, key, value, JSON.stringify(meta ?? {})]
    );
  }

  async delete(userId: string, key: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM user_memory WHERE user_id = $1 AND key = $2",
      [userId, key]
    );
  }

  async list(userId: string): Promise<MemoryEntry[]> {
    const { rows } = await this.pool.query(
      "SELECT key, value, meta, created_at FROM user_memory WHERE user_id = $1 ORDER BY updated_at DESC",
      [userId]
    );
    return (rows as Array<{ key: string; value: string; meta: Record<string, unknown>; created_at: string }>).map(
      (r) => ({
        key: r.key,
        value: r.value,
        tier: "user" as const,
        meta: r.meta,
        createdAt: new Date(r.created_at).getTime(),
      })
    );
  }

  async search(userId: string, query: string): Promise<MemoryEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT key, value, meta, created_at FROM user_memory
       WHERE user_id = $1 AND (key ILIKE $2 OR value ILIKE $2)
       ORDER BY updated_at DESC LIMIT 20`,
      [userId, `%${query}%`]
    );
    return (rows as Array<{ key: string; value: string; meta: Record<string, unknown>; created_at: string }>).map(
      (r) => ({
        key: r.key,
        value: r.value,
        tier: "user" as const,
        meta: r.meta,
        createdAt: new Date(r.created_at).getTime(),
      })
    );
  }
}
