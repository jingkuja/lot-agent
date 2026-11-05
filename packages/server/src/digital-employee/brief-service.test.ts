import { describe, expect, it, vi } from "vitest";
import { BriefService, briefMessage, localDate } from "./brief-service.js";

const counts = { scanned: 12, created: 3, confirm: 2, followUps: 4, results: 1, pending: 7 };

describe("BriefService", () => {
  it("uses the account's own calendar day", () => {
    const lateEvening = new Date("2026-11-05T17:00:00.000Z");
    expect(localDate(lateEvening, "Asia/Shanghai")).toBe("2026-11-06");
    expect(localDate(lateEvening, "America/New_York")).toBe("2026-11-05");
  });

  it("keeps the first brief of a day and stores only counts and references", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [{ timezone: "Asia/Shanghai" }] : [] }));
    await new BriefService({ query } as any).write("u1", counts, ["proposal:d1"], new Date("2026-11-05T01:00:00.000Z"));
    const [sql, params] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT (user_id, brief_date) DO NOTHING");
    expect(params).toEqual(["u1", "2026-11-05", JSON.stringify(counts), JSON.stringify(["proposal:d1"])]);
  });

  it("claims a delivery before anything is sent", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "b1", user_id: "u1", brief_date: "2026-11-05", counts }] }));
    await expect(new BriefService({ query } as any).claimFeishuDeliveries(20)).resolves.toEqual([
      { id: "b1", userId: "u1", date: "2026-11-05", counts },
    ]);
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain("feishu_attempted_at=now()");
    expect(sql).toContain("settings.feishu_reminder=true");
  });

  it("marks only the owner's brief as read", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new BriefService({ query } as any).markRead("u1", "b1");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("user_id=$2"), ["b1", "u1"]);
  });

  it("writes the Feishu message in the deployment's language", () => {
    expect(briefMessage(counts, "小灵", false)).toBe("小灵的今日简报：待确认 2 件，要跟进 4 位客户，等结果 1 个。");
    expect(briefMessage(counts, "Ling", true)).toContain("To confirm: 2");
  });
});
