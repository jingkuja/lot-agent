/** Timing for scheduled work, taken from lot-bot's schedules/presets.ts. */
export type ScheduleTiming =
  | { kind: "once"; at: string }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: parts.hour === "24" ? 0 : Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAY[parts.weekday!] ?? 0,
  };
}

/** The date a moment falls on where the owner is: daily limits count these days. */
export function localDate(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function zonedTimeToUtc(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = desired;
  for (let i = 0; i < 4; i++) {
    const wall = zonedParts(new Date(instant), timeZone);
    instant = desired - (Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0) - instant);
  }
  return new Date(instant);
}

/** The first occurrence after `from`, or null once a one-off has passed. */
export function nextRunAt(timing: ScheduleTiming, timeZone: string, from: Date): Date | null {
  if (timing.kind === "once") {
    const at = new Date(timing.at);
    return at.getTime() > from.getTime() ? at : null;
  }
  const wall = zonedParts(from, timeZone);
  const onDay = (dayOffset: number) => zonedTimeToUtc(timeZone, wall.year, wall.month, wall.day + dayOffset, timing.hour, timing.minute);
  if (timing.kind === "daily") {
    const today = onDay(0);
    return today.getTime() > from.getTime() ? today : onDay(1);
  }
  const days = (timing.weekday - wall.weekday + 7) % 7;
  const candidate = onDay(days);
  return candidate.getTime() > from.getTime() ? candidate : onDay(days + 7);
}
