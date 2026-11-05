import { describe, expect, it, vi } from "vitest";
import { EmployeeSettingsService } from "./settings-service.js";

const row = { employee_name: "阿灵", feishu_reminder: false, desktop_reminder: true, work_tone: "warm", preferred_channels: ["wechat"], version: 2 };
const input = { employeeName: "阿灵", feishuReminder: false, desktopReminder: true, workTone: "warm" as const, preferredChannels: ["wechat" as const] };

describe("EmployeeSettingsService", () => {
  it("returns the default employee before anything is saved", async () => {
    const service = new EmployeeSettingsService({ query: vi.fn(async () => ({ rows: [] })) } as any);
    await expect(service.get("u1")).resolves.toEqual({
      employeeName: "小灵", feishuReminder: false, desktopReminder: false, workTone: null, preferredChannels: [], version: 0,
    });
  });

  it("creates the row on the first save", async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row, version: 1 }] }));
    const saved = await new EmployeeSettingsService({ query } as any).save("u1", { ...input, version: 0 });
    expect(saved.version).toBe(1);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining("INSERT INTO de_employee_settings"), ["u1", "阿灵", false, true, "warm", ["wechat"]]]);
  });

  it("updates against the version the client read", async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    await new EmployeeSettingsService({ query } as any).save("u1", { ...input, version: 1 });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining("version = $7"), ["u1", "阿灵", false, true, "warm", ["wechat"], 1]]);
  });

  it.each([0, 3])("reports a stale save from version %i", async (version) => {
    const service = new EmployeeSettingsService({ query: vi.fn(async () => ({ rows: [] })) } as any);
    await expect(service.save("u1", { ...input, version })).rejects.toThrow("刷新");
  });
});
