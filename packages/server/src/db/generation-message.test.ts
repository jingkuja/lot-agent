import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

describe("updateMessageGeneration", () => {
  it("scopes the UPDATE to the owning conversation and user", async () => {
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn(async () => ({ rows: [] }));
    // @ts-expect-error inject a fake pool
    db.pool = { query };
    await db.updateMessageGeneration(
      "m1",
      { status: "completed", metadata: { kind: "generation", assets: [] } },
      { conversationId: "c1", userId: "u1" }
    );
    const [sql, params] = query.mock.calls[0];
    // A forged message id from job input must not update rows outside the
    // job's own conversation/user — the WHERE clause carries all three keys.
    expect(sql).toMatch(/UPDATE messages m SET status = \$1, metadata = \$2/);
    expect(sql).toMatch(/m\.id = \$3/);
    expect(sql).toMatch(/m\.conversation_id = \$4/);
    expect(sql).toMatch(/c\.user_id = \$5/);
    expect(params[0]).toBe("completed");
    expect(JSON.parse(params[1] as string)).toMatchObject({ kind: "generation" });
    expect(params.slice(2)).toEqual(["m1", "c1", "u1"]);
  });

  it("only transitions messages still 'generating' — terminal states are immutable", async () => {
    // Cache-hit race (#9): the worker can complete a generation before the
    // route's post-enqueue write lands. That write must not drag a completed/
    // failed/cancelled message back to 'generating' and drop its assets.
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn(async () => ({ rows: [] }));
    // @ts-expect-error inject a fake pool
    db.pool = { query };
    await db.updateMessageGeneration(
      "m1",
      { status: "generating", metadata: {} },
      { conversationId: "c1", userId: "u1" }
    );
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/m\.status = 'generating'/);
  });
});

describe("addMessage generation status", () => {
  it("persists the caller-provided status column on insert", async () => {
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn(async () => ({ rows: [] }));
    // @ts-expect-error inject a fake pool
    db.pool = { query };
    await db.addMessage("m1", "c1", "assistant", "", { status: "generating" });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/status/);
    expect(params).toContain("generating");
  });

  it("defaults the status column to 'completed'", async () => {
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn(async () => ({ rows: [] }));
    // @ts-expect-error inject a fake pool
    db.pool = { query };
    await db.addMessage("m1", "c1", "user", "hi");
    const [, params] = query.mock.calls[0];
    expect(params).toContain("completed");
  });
});
