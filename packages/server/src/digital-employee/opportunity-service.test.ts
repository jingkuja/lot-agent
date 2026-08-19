import { describe, expect, it, vi } from "vitest";
import { OpportunityService } from "./opportunity-service.js";

describe("OpportunityService settings", () => {
  it("uses consistent explicit parameter types when saving settings", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        enabled: true,
        timezone: "Asia/Shanghai",
        daily_run_time: "09:30:00",
        next_run_at: null,
        last_run_at: null,
        version: 1,
      }],
    }));
    const service = new OpportunityService({ pool: { query } } as any);

    await service.saveSettings("u1", {
      enabled: true,
      timezone: "Asia/Shanghai",
      dailyRunTime: "09:30",
      version: 0,
    });

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("$2::boolean");
    expect(sql).toContain("$3::text");
    expect(sql).toContain("$4::time");
    expect(query).toHaveBeenCalledWith(expect.any(String), ["u1", true, "Asia/Shanghai", "09:30", 0]);
  });
});
