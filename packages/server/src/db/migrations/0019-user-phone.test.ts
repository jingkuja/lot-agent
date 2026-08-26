import { describe, expect, it, vi } from "vitest";
import { migrations } from "./index.js";
import { userPhone } from "./0019-user-phone.js";

describe("user phone migration", () => {
  it("adds the local display-safe phone column", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await userPhone.up({ query } as any);

    expect(String(query.mock.calls[0][0])).toContain("phone VARCHAR(32)");
    expect(userPhone.version).toBe(19);
    expect(migrations.at(-1)).toBe(userPhone);
  });
});
