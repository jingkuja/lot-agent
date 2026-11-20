import { describe, expect, it } from "vitest";
import { parseAssignmentScheduleInput } from "./assignment-schedule-validators.js";

const base = {
  goal: "每天整理客户跟进", mode: "autonomous", attachments: [], creditLimit: null,
  timing: { kind: "interval", startAt: "2026-11-05T03:00:00+08:00", every: 1, unit: "days" }, timezone: "Asia/Shanghai",
};

describe("assignment schedule validation", () => {
  it("uses the ordinary assignment validation and normalizes instants", () => {
    expect(parseAssignmentScheduleInput(base)).toMatchObject({
      assignment: { goal: "每天整理客户跟进", mode: "autonomous" },
      timing: { kind: "interval", startAt: "2026-11-04T19:00:00.000Z", every: 1, unit: "days" },
    });
  });

  it.each([
    [{ ...base, goal: "" }],
    [{ ...base, timing: { kind: "interval", startAt: "2026-11-05", every: 0, unit: "days" } }],
    [{ ...base, timing: { kind: "interval", startAt: "2026-11-05T09:30", every: 1, unit: "days" } }],
    [{ ...base, timing: { kind: "interval", startAt: "bad", every: 1, unit: "days" } }],
    [{ ...base, timing: { kind: "weekly" } }],
    [{ ...base, timezone: "Mars/Base" }],
  ])("rejects invalid input", (input) => {
    expect(() => parseAssignmentScheduleInput(input)).toThrow();
  });
});
