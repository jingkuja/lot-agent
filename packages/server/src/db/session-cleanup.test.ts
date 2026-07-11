import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

function fakeDb(rowCount: number | null) {
  const db = Object.create(DB.prototype) as DB;
  const query = vi.fn(async () => ({ rows: [], rowCount }));
  // @ts-expect-error inject a fake pool
  db.pool = { query };
  return { db, query };
}

/**
 * #16: sessions have a hard 7-day expiry (session-store.ts) but nothing ever
 * deleted the expired rows — the table grew unbounded. This just sweeps them;
 * sliding renewal / device management are out of scope (product decision).
 */
describe("deleteExpiredSessions", () => {
  it("deletes rows whose expires_at has passed", async () => {
    const { db, query } = fakeDb(4);
    await expect(db.deleteExpiredSessions()).resolves.toBe(4);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM sessions WHERE expires_at < now\(\)/);
  });

  it("returns 0 when rowCount is null", async () => {
    const { db } = fakeDb(null);
    await expect(db.deleteExpiredSessions()).resolves.toBe(0);
  });
});
