import { describe, expect, it } from "vitest";
import { isValidTimeZone, localDate, nextRunAt } from "./schedule-timing.js";

const TZ = "Asia/Shanghai";
// A Thursday, 10:00 in Shanghai.
const NOW = new Date("2026-11-05T02:00:00.000Z");

describe("nextRunAt", () => {
  it("runs a daily time later today, or tomorrow once it has passed", () => {
    expect(nextRunAt({ kind: "daily", hour: 11, minute: 30 }, TZ, NOW)?.toISOString()).toBe("2026-11-05T03:30:00.000Z");
    expect(nextRunAt({ kind: "daily", hour: 9, minute: 0 }, TZ, NOW)?.toISOString()).toBe("2026-11-06T01:00:00.000Z");
  });

  it("never returns the moment it is given, so a due schedule always moves forward", () => {
    expect(nextRunAt({ kind: "daily", hour: 10, minute: 0 }, TZ, NOW)?.toISOString()).toBe("2026-11-06T02:00:00.000Z");
    expect(nextRunAt({ kind: "weekly", weekday: 4, hour: 10, minute: 0 }, TZ, NOW)?.toISOString()).toBe("2026-11-12T02:00:00.000Z");
  });

  it("finds the coming weekday", () => {
    expect(nextRunAt({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, TZ, NOW)?.toISOString()).toBe("2026-11-09T01:00:00.000Z");
    expect(nextRunAt({ kind: "weekly", weekday: 4, hour: 12, minute: 0 }, TZ, NOW)?.toISOString()).toBe("2026-11-05T04:00:00.000Z");
  });

  it("crosses a month end on the owner's calendar", () => {
    const end = new Date("2026-11-30T15:00:00.000Z"); // Nov 30, 23:00 in Shanghai
    expect(nextRunAt({ kind: "daily", hour: 9, minute: 0 }, TZ, end)?.toISOString()).toBe("2026-12-01T01:00:00.000Z");
  });

  it("keeps the wall clock across a daylight saving change", () => {
    const before = new Date("2026-03-07T20:00:00.000Z"); // Mar 7, 15:00 in New York, before the change
    expect(nextRunAt({ kind: "daily", hour: 9, minute: 0 }, "America/New_York", before)?.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("runs a one-off once", () => {
    expect(nextRunAt({ kind: "once", at: "2026-11-05T03:00:00.000Z" }, TZ, NOW)?.toISOString()).toBe("2026-11-05T03:00:00.000Z");
    expect(nextRunAt({ kind: "once", at: "2026-11-05T01:00:00.000Z" }, TZ, NOW)).toBeNull();
  });
});

describe("helpers", () => {
  it("counts days where the owner is", () => {
    expect(localDate(new Date("2026-11-05T17:00:00.000Z"), TZ)).toBe("2026-11-06");
  });

  it("recognizes time zones", () => {
    expect(isValidTimeZone(TZ)).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});
