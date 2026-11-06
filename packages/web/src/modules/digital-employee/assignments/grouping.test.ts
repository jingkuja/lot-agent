import { describe, expect, it } from "vitest";
import type { Assignment } from "../types.js";
import { dayKey, dayLabel, groupByDay, quickRange, toLocalInput } from "./grouping.js";

const task = (id: string, createdAt: Date) => ({ id, createdAt: createdAt.toISOString() }) as Assignment;
const local = (day: number, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute);

describe("task days", () => {
  it("groups by the browser's calendar day, newest first", () => {
    const groups = groupByDay([task("a", local(5, 23, 59)), task("b", local(6, 0, 1)), task("c", local(5, 0, 0))]);
    expect(groups.map((group) => [group.day, group.items.map((item) => item.id)])).toEqual([
      ["2026-11-06", ["b"]],
      ["2026-11-05", ["a", "c"]],
    ]);
  });

  it("keeps the midnight boundary on the local day whatever the UTC date is", () => {
    expect(dayKey(local(6, 0, 0))).toBe("2026-11-06");
    expect(dayKey(new Date(local(6, 0, 0).getTime() - 1))).toBe("2026-11-05");
  });

  it("names today and yesterday", () => {
    const now = local(6);
    expect(dayLabel("2026-11-06", now, "zh-CN").relative).toBe("今天");
    expect(dayLabel("2026-11-05", now, "zh-CN").relative).toBe("昨天");
    expect(dayLabel("2026-11-04", now, "zh-CN").relative).toBeNull();
    expect(dayLabel("2025-11-04", now, "en-US").date).toContain("2025");
  });
});

describe("quick ranges", () => {
  const now = local(6, 15, 30);

  it("covers whole days", () => {
    expect(quickRange("today", now)).toEqual({ from: local(6, 0), to: local(6, 23, 59) });
    expect(quickRange("yesterday", now)).toEqual({ from: local(5, 0), to: local(5, 23, 59) });
    expect(quickRange("week", now).from).toEqual(local(6 - 6, 0));
    expect(quickRange("month", now).from).toEqual(new Date(2026, 9, 8));
  });

  it("writes what a datetime-local input expects", () => {
    expect(toLocalInput(local(6, 9, 5))).toBe("2026-11-06T09:05");
  });
});
