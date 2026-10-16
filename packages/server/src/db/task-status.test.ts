import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

function fakeDb(rowCount = 1) {
  const db = Object.create(DB.prototype) as DB;
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount }));
  // @ts-expect-error inject a fake pool
  db.pool = { query };
  return { db, query };
}

/**
 * Task rows follow a one-way state machine:
 *   pending -> running -> succeeded | failed
 *   pending/running -> cancelled
 * Terminal `cancelled` must never be overwritten by a late success/failure —
 * every transition carries a WHERE-status guard.
 */
describe("task status transitions", () => {
  it("stores the selected queue with the original task input", async () => {
    const { db, query } = fakeDb();
    await db.createTask("t1", "marketing.video", { original: true }, "owner", "lot-marketing-video");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("queue_name"), ["t1", "marketing.video", '{"original":true}', "owner", "lot-marketing-video"]);
  });

  it("only reads old unclaimed tasks, without declaring queue latency a failure", async () => {
    const { db, query } = fakeDb();
    await db.findStalePendingTasks(60_000);
    expect(query.mock.calls[0][0]).toContain("queue_name IN ('lot-tasks','lot-marketing-video')");
    expect(query.mock.calls[0][0]).toContain("status = 'pending' AND attempts = 0");
    expect(query.mock.calls[0][0]).not.toContain("UPDATE");
  });

  it("markTaskRunning is guarded and reports whether it claimed the task", async () => {
    const { db, query } = fakeDb(1);
    await expect(db.markTaskRunning("t1", 1)).resolves.toBe(true);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/status IN \('pending','running'\)/);
    expect(sql).not.toContain("'failed'");
  });

  it("keeps a permitted retry nonterminal and scoped to the current attempt", async () => {
    const { db, query } = fakeDb();
    await db.markTaskRetryPending("t1", 1);
    expect(query.mock.calls[0][0]).toContain("status = 'pending'");
    expect(query.mock.calls[0][0]).toContain("status = 'running' AND attempts = $2");
    expect(query.mock.calls[0][1]).toEqual(["t1", 1]);
  });

  it("markTaskRunning returns false for a task already cancelled", async () => {
    const { db } = fakeDb(0);
    await expect(db.markTaskRunning("t1", 1)).resolves.toBe(false);
  });

  it("setTaskResult cannot overwrite a cancelled task", async () => {
    const { db, query } = fakeDb();
    await db.setTaskResult("t1", { ok: true });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/status IN \('pending','running'\)/);
  });

  it("setTaskError cannot overwrite a cancelled task", async () => {
    const { db, query } = fakeDb();
    await db.setTaskError("t1", "boom");
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/status IN \('pending','running'\)/);
  });

  it("getTaskStatus reads the current status", async () => {
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn(async () => ({ rows: [{ status: "cancelled" }] }));
    // @ts-expect-error inject a fake pool
    db.pool = { query };
    await expect(db.getTaskStatus("t1")).resolves.toBe("cancelled");
  });
});
