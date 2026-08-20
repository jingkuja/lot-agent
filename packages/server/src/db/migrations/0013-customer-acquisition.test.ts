import { describe, expect, it, vi } from "vitest";
import { customerAcquisition } from "./0013-customer-acquisition.js";
import { migrations } from "./index.js";

describe("customer acquisition migration", () => {
  it("registers the independent cohort-marketing lifecycle", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await customerAcquisition.up({ query } as any);
    const ddl = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(customerAcquisition.version).toBe(13);
    expect(migrations.at(-1)).toBe(customerAcquisition);
    expect(ddl).toContain("de_customer_segments");
    expect(ddl).toContain("de_customer_segment_snapshots");
    expect(ddl).toContain("de_marketing_asset_library");
    expect(ddl).toContain("de_asset_deployments");
    expect(ddl).toContain("de_daily_recommendations");
    expect(ddl).not.toContain("gpt");
  });
});
