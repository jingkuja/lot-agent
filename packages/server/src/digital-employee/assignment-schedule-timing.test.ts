import { describe, expect, it } from "vitest";
import { nextAssignmentRunAt } from "./assignment-schedule-timing.js";

const NOW = new Date("2026-11-05T02:00:00.000Z");

describe("assignment schedule timing", () => {
  it("runs a one-off only in the future", () => {
    expect(nextAssignmentRunAt({ kind: "once", at: "2026-11-05T03:00:00.000Z" }, NOW)?.toISOString()).toBe("2026-11-05T03:00:00.000Z");
    expect(nextAssignmentRunAt({ kind: "once", at: "2026-11-05T02:00:00.000Z" }, NOW)).toBeNull();
  });

  it("keeps the first interval occurrence and then advances by the selected unit", () => {
    const timing = { kind: "interval", startAt: "2026-11-05T03:00:00.000Z", every: 2, unit: "hours" } as const;
    expect(nextAssignmentRunAt(timing, NOW)?.toISOString()).toBe("2026-11-05T03:00:00.000Z");
    expect(nextAssignmentRunAt(timing, new Date("2026-11-05T03:00:00.000Z"))?.toISOString()).toBe("2026-11-05T05:00:00.000Z");
  });

  it("collapses missed interval occurrences instead of replaying a backlog", () => {
    const timing = { kind: "interval", startAt: "2026-11-05T01:00:00.000Z", every: 30, unit: "minutes" } as const;
    expect(nextAssignmentRunAt(timing, new Date("2026-11-05T03:10:00.000Z"))?.toISOString()).toBe("2026-11-05T03:30:00.000Z");
  });
});
