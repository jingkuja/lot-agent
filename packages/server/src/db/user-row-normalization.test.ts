import { describe, expect, it, vi } from "vitest";
import { DB } from "./database.js";

function fakeDb(row: Record<string, unknown>) {
  const db = Object.create(DB.prototype) as DB;
  const query = vi.fn(async () => ({ rows: [row] }));
  // @ts-expect-error inject a fake pool
  db.pool = { query };
  return db;
}

describe("user row normalization", () => {
  it("converts pg BIGINT user and managed-token ids to numbers", async () => {
    const user = await fakeDb({
      id: "local-1",
      external_user_id: "7",
      managed_token_id: "9",
      api_key: null,
      api_keys: null,
      managed_api_key: null,
    }).getUserById("local-1");

    expect(user).toMatchObject({
      external_user_id: 7,
      managed_token_id: 9,
    });
    expect(typeof user?.external_user_id).toBe("number");
    expect(typeof user?.managed_token_id).toBe("number");
  });

  it("rejects BIGINT values that cannot be represented safely", async () => {
    const db = fakeDb({
      id: "local-1",
      external_user_id: "9007199254740992",
      api_key: null,
      api_keys: null,
      managed_api_key: null,
    });

    await expect(db.getUserById("local-1")).rejects.toThrow(
      "invalid external_user_id returned by PostgreSQL"
    );
  });
});
