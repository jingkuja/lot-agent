import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

describe("updateMessageGeneration", () => {
  it("UPDATEs status + metadata for the message id", async () => {
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn(async () => ({ rows: [] }));
    // @ts-expect-error inject a fake pool
    db.pool = { query };
    await db.updateMessageGeneration("m1", { status: "completed", metadata: { kind: "generation", assets: [] } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE messages SET status = \$1, metadata = \$2 WHERE id = \$3/);
    expect(params[0]).toBe("completed");
    expect(JSON.parse(params[1] as string)).toMatchObject({ kind: "generation" });
    expect(params[2]).toBe("m1");
  });
});
