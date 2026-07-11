import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

function fakeDb(rowCount = 1) {
  const db = Object.create(DB.prototype) as DB;
  const query = vi.fn(async () => ({ rows: [], rowCount }));
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
  it("markTaskRunning is guarded and reports whether it claimed the task", async () => {
    const { db, query } = fakeDb(1);
    await expect(db.markTaskRunning("t1", 1)).resolves.toBe(true);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/status IN \('pending','running','failed'\)/);
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
