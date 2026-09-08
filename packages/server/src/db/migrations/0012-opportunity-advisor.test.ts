import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "../migration-runner.js";
import { migrations } from "./index.js";
import { opportunityAdvisor } from "./0012-opportunity-advisor.js";

describe("opportunity advisor migration", () => {
  it("extends the follow-up workflow idempotently", async () => {
    const statements: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    }) } as QueryClient;

    await opportunityAdvisor.up(client);
    const ddl = statements.join("\n");
    expect(opportunityAdvisor.version).toBe(12);
    expect(migrations.find((migration) => migration.version === 12)).toBe(opportunityAdvisor);
    expect(ddl).toContain("opportunity_type");
    expect(ddl).toContain("risk_flags JSONB");
    expect(ddl).toContain("snoozed_until");
    expect(ddl).toContain("awaiting_result");
    expect(ddl).toContain("follow_up_task_id");
  });
});
