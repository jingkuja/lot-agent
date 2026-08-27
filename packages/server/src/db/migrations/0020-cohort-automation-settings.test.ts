import { describe, expect, it, vi } from "vitest";
import { migrations } from "./index.js";
import { cohortAutomationSettings } from "./0020-cohort-automation-settings.js";

describe("cohort automation settings migration", () => {
  it("creates a default-off per-user setting", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await cohortAutomationSettings.up({ query } as any);

    const ddl = String(query.mock.calls[0][0]);
    expect(ddl).toContain("de_cohort_automation_settings");
    expect(ddl).toContain("enabled      BOOLEAN NOT NULL DEFAULT false");
    expect(cohortAutomationSettings.version).toBe(20);
    expect(migrations.at(-1)).toBe(cohortAutomationSettings);
  });
});
