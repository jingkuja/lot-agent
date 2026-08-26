import { describe, expect, it, vi } from "vitest";
import { repeatableManualOpportunityDiscovery } from "./0017-repeatable-manual-opportunity-discovery.js";
import { migrations } from "./index.js";

describe("repeatable manual opportunity discovery migration", () => {
  it("removes daily uniqueness while retaining a scan-date lookup index", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await repeatableManualOpportunityDiscovery.up({ query } as any);

    const ddl = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(ddl).toContain("DROP CONSTRAINT IF EXISTS de_follow_up_suggestion_runs_user_id_scan_date_key");
    expect(ddl).toContain("idx_de_follow_up_runs_user_scan_date");
    expect(repeatableManualOpportunityDiscovery.version).toBe(17);
    expect(migrations.find((migration) => migration.version === 17)).toBe(repeatableManualOpportunityDiscovery);
  });
});
