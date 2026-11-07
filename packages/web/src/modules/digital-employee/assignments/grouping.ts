import type { Assignment } from "../types.js";

export type QuickRange = "today" | "yesterday" | "week" | "month";

export interface DayGroup {
  day: string;
  items: Assignment[];
}

/** The owner's calendar day, in the browser's timezone. */
export function dayKey(value: Date | string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

/** Newest day first. A task stays on the day it was created, even if it ran past midnight. */
export function groupByDay(items: Assignment[]): DayGroup[] {
  const groups = new Map<string, Assignment[]>();
  for (const item of items) {
    const key = dayKey(item.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([day, dayItems]) => ({ day, items: dayItems }));
}

export function dayLabel(day: string, now: Date, locale: string): { relative: "今天" | "昨天" | null; date: string } {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const value = new Date(year, month - 1, date);
  return {
    relative: day === dayKey(now) ? "今天" : day === dayKey(addDays(now, -1)) ? "昨天" : null,
    date: new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "short", ...(year === now.getFullYear() ? {} : { year: "numeric" }) }).format(value),
  };
}

/** A shortcut fills the same two fields a person can type into. Ends at the last minute of the day. */
export function quickRange(range: QuickRange, now: Date): { from: Date; to: Date } {
  const today = startOfDay(now);
  const endOf = (day: Date) => new Date(addDays(day, 1).getTime() - 60_000);
  if (range === "yesterday") {
    const yesterday = addDays(today, -1);
    return { from: yesterday, to: endOf(yesterday) };
  }
  return { from: addDays(today, range === "week" ? -6 : range === "month" ? -29 : 0), to: endOf(today) };
}

/** The format a `datetime-local` input reads and writes, in local time. */
export function toLocalInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function isOpenStatus(status: Assignment["status"]): boolean {
  return status === "queued" || status === "running" || status.startsWith("waiting_");
}

export function isOpen(item: Assignment): boolean {
  return isOpenStatus(item.status);
}
