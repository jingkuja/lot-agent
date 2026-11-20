export type AssignmentIntervalUnit = "minutes" | "hours" | "days";

export type AssignmentScheduleTiming =
  | { kind: "once"; at: string }
  | { kind: "interval"; startAt: string; every: number; unit: AssignmentIntervalUnit };

const UNIT_MS: Record<AssignmentIntervalUnit, number> = {
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
};

/** Intervals are anchored to their first run. Missed occurrences collapse to the next future one. */
export function nextAssignmentRunAt(timing: AssignmentScheduleTiming, from: Date): Date | null {
  if (timing.kind === "once") {
    const at = new Date(timing.at);
    return at.getTime() > from.getTime() ? at : null;
  }
  const start = new Date(timing.startAt).getTime();
  const step = timing.every * UNIT_MS[timing.unit];
  if (start > from.getTime()) return new Date(start);
  const occurrences = Math.floor((from.getTime() - start) / step) + 1;
  return new Date(start + occurrences * step);
}
