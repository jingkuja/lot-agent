import type { Pool } from "pg";

/**
 * Minimal face of `pg.PoolClient`/`pg.Pool.query` a migration's `up()` needs.
 * Kept narrow (not the full `pg` type) so callers — and tests — can inject a
 * fake without depending on the `pg` package.
 */
export interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface Migration {
  /** Starts at 1, strictly increasing, no gaps required but no duplicates/out-of-order either. */
  version: number;
  /** Human-readable label, e.g. "baseline". Stored in `schema_migrations.name` for audit. */
  name: string;
  up(client: QueryClient): Promise<void>;
}

// Arbitrary fixed key for `pg_advisory_lock`. Any bigint works — it just has
// to be a constant unique to this app so concurrent processes (e.g. two
// server replicas booting together) serialize on the *same* lock rather than
// each grabbing their own. Picked by hashing "lot-agent-migrations" down to a
// value that fits Postgres's int8 lock-key range; no significance beyond that.
const MIGRATION_LOCK_KEY = 7_402_195_831;

function assertStrictlyOrdered(migrations: Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version <= migrations[i - 1].version) {
      throw new Error(
        `migrations must be strictly ordered by version with no duplicates ` +
          `(version ${migrations[i].version} "${migrations[i].name}" does not come after ` +
          `version ${migrations[i - 1].version} "${migrations[i - 1].name}")`
      );
    }
  }
}

/**
 * Applies any `migrations` not yet recorded in `schema_migrations`, in
 * ascending version order. A Postgres advisory lock serializes concurrent
 * callers (e.g. two server replicas booting at once) so only one actually
 * runs DDL; the other blocks on the lock and then finds everything already
 * applied. Each migration runs in its own transaction — a failure rolls back
 * just that migration (and nothing is recorded for it), leaving previously
 * applied migrations intact and the failure safe to retry on next boot.
 */
export async function runMigrations(pool: Pool, migrations: Migration[]): Promise<void> {
  assertStrictlyOrdered(migrations);

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version     INT         PRIMARY KEY,
          name        TEXT        NOT NULL,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      const { rows } = await client.query("SELECT version FROM schema_migrations");
      const applied = new Set<number>(rows.map((r) => Number(r.version)));

      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;

        try {
          await client.query("BEGIN");
          await migration.up(client);
          await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
            migration.version,
            migration.name,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          const cause = error instanceof Error ? error : new Error(String(error));
          throw new Error(
            `migration ${migration.version} ("${migration.name}") failed: ${cause.message}`,
            { cause }
          );
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
