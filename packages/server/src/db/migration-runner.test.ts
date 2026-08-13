import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { runMigrations, type Migration, type QueryClient } from "./migration-runner.js";

/**
 * Fake `pg.Pool`/`PoolClient` pair that just records every `query()` call
 * (sql + params) in a shared array, and a `rowsFor` map so a test can control
 * what a specific query returns (e.g. pre-seeding `schema_migrations` rows).
 */
function fakePool(rowsFor: Record<string, unknown[]> = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const released = { count: 0 };
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    for (const [pattern, rows] of Object.entries(rowsFor)) {
      if (sql.includes(pattern)) return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client: QueryClient & { release: () => void } = {
    query,
    release: () => {
      released.count += 1;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, calls, released, query };
}

function migration(version: number, name: string, up: Migration["up"]): Migration {
  return { version, name, up };
}

describe("runMigrations", () => {
  it("rejects out-of-order versions", async () => {
    const { pool } = fakePool();
    const migrations = [
      migration(2, "second", async () => {}),
      migration(1, "first", async () => {}),
    ];
    await expect(runMigrations(pool, migrations)).rejects.toThrow(/strictly ordered/);
  });

  it("rejects duplicate versions", async () => {
    const { pool } = fakePool();
    const migrations = [
      migration(1, "first", async () => {}),
      migration(1, "first-again", async () => {}),
    ];
    await expect(runMigrations(pool, migrations)).rejects.toThrow(/strictly ordered/);
  });

  it("runs a fresh database's migrations in order and records each", async () => {
    const { pool, calls, released } = fakePool();
    const ran: number[] = [];
    const migrations = [
      migration(1, "baseline", async () => {
        ran.push(1);
      }),
      migration(2, "second", async () => {
        ran.push(2);
      }),
    ];

    await runMigrations(pool, migrations);

    expect(ran).toEqual([1, 2]);
    const sqls = calls.map((c) => c.sql);
    // advisory lock before the schema_migrations table is created
    const lockIdx = sqls.findIndex((s) => s.includes("pg_advisory_lock"));
    const createIdx = sqls.findIndex((s) => s.includes("CREATE TABLE IF NOT EXISTS schema_migrations"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(lockIdx);

    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO schema_migrations"));
    expect(inserts.map((c) => c.params)).toEqual([
      [1, "baseline"],
      [2, "second"],
    ]);

    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("COMMIT");
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(released.count).toBe(1);
  });

  it("skips already-applied versions and only runs the missing ones", async () => {
    const { pool } = fakePool({
      "SELECT version FROM schema_migrations": [{ version: 1 }],
    });
    const ran: number[] = [];
    const migrations = [
      migration(1, "baseline", async () => {
        ran.push(1);
      }),
      migration(2, "second", async () => {
        ran.push(2);
      }),
    ];

    await runMigrations(pool, migrations);

    expect(ran).toEqual([2]);
  });

  it("rolls back, unlocks, and releases without recording when up() throws", async () => {
    const { pool, calls, released } = fakePool();
    const migrations = [
      migration(1, "boom", async () => {
        throw new Error("kaboom");
      }),
    ];

    await expect(runMigrations(pool, migrations)).rejects.toThrow(/boom.*kaboom/s);

    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls.some((s) => s.includes("INSERT INTO schema_migrations"))).toBe(false);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(released.count).toBe(1);
  });
});
