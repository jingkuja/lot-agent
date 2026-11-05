import { describe, expect, it } from "vitest";
import { InputError } from "./errors.js";
import { parseScheduleInput } from "./schedule-validators.js";

const base = { template: "weekly_review", timing: { kind: "weekly", weekday: 1, hour: 9, minute: 0 } };

describe("parseScheduleInput", () => {
  it("fills in the default time zone and stays on", () => {
    expect(parseScheduleInput(base)).toEqual({ ...base, timezone: "Asia/Shanghai", enabled: true });
  });

  it("keeps only the fields of a timing", () => {
    expect(parseScheduleInput({ ...base, timing: { kind: "daily", hour: 8, minute: 30, cron: "* * * * *" } }).timing).toEqual({ kind: "daily", hour: 8, minute: 30 });
    expect(parseScheduleInput({ ...base, timing: { kind: "once", at: "2026-11-06T01:00:00+08:00" } }).timing).toEqual({ kind: "once", at: "2026-11-05T17:00:00.000Z" });
  });

  it.each([
    [{ ...base, template: "send_to_everyone" }],
    [{ ...base, timezone: "Mars/Base" }],
    [{ ...base, timing: { kind: "hourly" } }],
    [{ ...base, timing: { kind: "daily", hour: 24, minute: 0 } }],
    [{ ...base, timing: { kind: "weekly", weekday: 7, hour: 9, minute: 0 } }],
    [{ ...base, timing: { kind: "once", at: "soon" } }],
    [{ ...base, timing: null }],
  ])("rejects %j", (input) => {
    expect(() => parseScheduleInput(input as Record<string, unknown>)).toThrow(InputError);
  });
});
