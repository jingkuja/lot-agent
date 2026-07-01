import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

function mockDb() {
  const db = Object.create(DB.prototype) as DB;
  const query = vi.fn(async () => ({ rows: [] }));
  // @ts-expect-error inject a fake pool
  db.pool = { query };
  return { db, query };
}

describe("listConversations", () => {
  it("excludes conversations that have no messages (empty shells)", async () => {
    const { db, query } = mockDb();
    await db.listConversations("u1", { limit: 20 });
    const [sql] = query.mock.calls[0];
    // An EXISTS subquery against messages keeps empty conversations out of the
    // list, so the workspace never opens a 0-message conversation that renders
    // identically to a brand-new chat.
    expect(sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM messages .*conversation_id = conversations\.id/i
    );
  });

  it("still scopes by user and orders latest-first", async () => {
    const { db, query } = mockDb();
    await db.listConversations("u1", { limit: 20 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/user_id = \$1/);
    expect(sql).toMatch(/ORDER BY updated_at DESC, id DESC/);
    expect(params).toContain("u1");
  });

  it("applies the empty-shell filter on the non-paginated path too", async () => {
    const { db, query } = mockDb();
    await db.listConversations("u1");
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM messages/i);
    expect(sql).not.toMatch(/LIMIT/);
  });
});
