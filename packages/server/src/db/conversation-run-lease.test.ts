import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

function fakeDb(rowCount: number) {
  const db = Object.create(DB.prototype) as DB;
  const query = vi.fn(async () => ({ rows: [], rowCount }));
  // @ts-expect-error inject a fake pool
  db.pool = { query };
  return { db, query };
}

/**
 * Report #20 (concurrency half) / architecture #10: conversation run lease
 * CAS. These tests pin down the SQL shape (claim only succeeds when idle or
 * stale; release only clears a matching runId — fencing) the same way
 * regenerate-boundary.test.ts pins the seq-boundary SQL.
 */
describe("claimConversationRun", () => {
  it("CASes on idle-or-stale and stamps the new runId + now()", async () => {
    const { db, query } = fakeDb(1);
    await db.claimConversationRun("c1", "run-1", 600_000);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE conversations/);
    expect(sql).toMatch(/SET active_run_id = \$2, run_started_at = now\(\)/);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(sql).toMatch(/active_run_id IS NULL OR run_started_at < now\(\) - make_interval\(secs => \$3::double precision \/ 1000\.0\)/);
    expect(params).toEqual(["c1", "run-1", 600_000]);
  });

  it("returns true when it won the claim (rowCount > 0)", async () => {
    const { db } = fakeDb(1);
    await expect(db.claimConversationRun("c1", "run-1", 600_000)).resolves.toBe(true);
  });

  it("returns false when it lost the claim (rowCount 0 — another run holds a fresh lease)", async () => {
    const { db } = fakeDb(0);
    await expect(db.claimConversationRun("c1", "run-1", 600_000)).resolves.toBe(false);
  });
});

describe("releaseConversationRun", () => {
  it("clears active_run_id/run_started_at scoped to id AND the caller's own runId (fencing)", async () => {
    const { db, query } = fakeDb(1);
    await db.releaseConversationRun("c1", "run-1");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE conversations SET active_run_id = NULL, run_started_at = NULL/);
    expect(sql).toMatch(/WHERE id = \$1 AND active_run_id = \$2/);
    expect(params).toEqual(["c1", "run-1"]);
  });
});
