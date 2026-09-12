import { describe, expect, it, vi } from "vitest";
import { migrations } from "./index.js";
import { userWechat } from "./0022-user-wechat.js";

describe("user wechat migration", () => {
  it("adds openid/unionid columns and a partial unique index", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await userWechat.up({ query } as any);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("wechat_openid VARCHAR(64)");
    expect(sql).toContain("wechat_unionid VARCHAR(64)");
    expect(sql).toContain("users_wechat_openid_uidx");
    expect(userWechat.version).toBe(22);
    expect(migrations.find((migration) => migration.version === 22)).toBe(userWechat);
  });
});
