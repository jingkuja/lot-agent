import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "../migration-runner.js";
import { migrations } from "./index.js";
import { digitalEmployeeFollowUpCopy } from "./0010-digital-employee-follow-up-copy.js";

function recordingClient() {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as QueryClient, statements };
}

describe("digital employee follow-up/copy schema migration", () => {
  it("remains registered at version 10", () => {
    expect(digitalEmployeeFollowUpCopy.version).toBe(10);
    expect(migrations.find((migration) => migration.version === 10)).toBe(digitalEmployeeFollowUpCopy);
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("creates the complete follow-up and copy schema with integrity guards", async () => {
    const { client, statements } = recordingClient();

    await digitalEmployeeFollowUpCopy.up(client);

    const ddl = statements.join("\n");
    for (const table of [
      "de_follow_up_suggestion_runs",
      "de_follow_up_suggestions",
      "de_follow_up_tasks",
      "de_follow_up_automation_settings",
      "de_follow_up_records",
      "de_copy_projects",
      "de_copy_generation_runs",
      "de_copy_drafts",
    ]) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(ddl).toContain("UNIQUE (user_id, scan_date)");
    expect(ddl).toContain("UNIQUE (user_id, dedup_key)");
    expect(ddl).toMatch(/suggestion_id\s+UUID UNIQUE/);
    expect(ddl).toContain("UNIQUE (user_id, idempotency_key)");
    expect(ddl).toContain("CHECK (status IN ('suggested', 'accepted', 'dismissed', 'expired'))");
    expect(ddl).toContain("CHECK (status IN ('pending', 'completed', 'cancelled'))");
    expect(ddl).toContain("idx_de_follow_up_settings_due");
    expect(ddl).toContain("idx_de_copy_projects_user_status_updated");
    expect(ddl).toContain("fk_de_copy_projects_selected_draft");
    expect(ddl).toContain("trg_de_follow_up_tasks_updated_at");
    expect(ddl).toContain("trg_de_copy_drafts_updated_at");
  });
});
