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
 * #17: the boundary message's seq subquery must be scoped to the same
 * conversation — otherwise a messageId from a different conversation lets a
 * caller smuggle in that conversation's ordering as the deletion boundary.
 * (#20: the boundary itself moved from created_at to seq for stable ordering.)
 */
describe("deleteMessagesFromAndAfter", () => {
  it("scopes the boundary subquery to the same conversation", async () => {
    const { db, query } = fakeDb(3);
    await db.deleteMessagesFromAndAfter("c1", "m1");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT seq FROM messages WHERE id = \$2 AND conversation_id = \$1/);
    expect(params).toEqual(["c1", "m1"]);
  });

  it("returns true when the boundary message existed (rows deleted)", async () => {
    const { db } = fakeDb(3);
    await expect(db.deleteMessagesFromAndAfter("c1", "m1")).resolves.toBe(true);
  });

  it("returns false when the boundary message doesn't belong to this conversation", async () => {
    const { db } = fakeDb(0);
    await expect(db.deleteMessagesFromAndAfter("c1", "other-convo-msg")).resolves.toBe(false);
  });
});
