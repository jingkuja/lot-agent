import { describe, expect, it, vi } from "vitest";
import { managedNewApiKey } from "./0018-managed-new-api-key.js";
import { migrations } from "./index.js";

describe("managed New API key migration", () => {
  it("adds encrypted managed credential columns", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await managedNewApiKey.up({ query } as any);
    const ddl = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(ddl).toContain("managed_api_key TEXT");
    expect(managedNewApiKey.version).toBe(18);
    expect(migrations.find((migration) => migration.version === managedNewApiKey.version)).toBe(managedNewApiKey);
  });
});
