import { InputError } from "./errors.js";
import type { ScheduleInput } from "./schedule-service.js";
import { SCHEDULE_TEMPLATES, type ScheduleTemplate } from "./schedule-templates.js";
import { DEFAULT_TIMEZONE, isValidTimeZone, type ScheduleTiming } from "./schedule-timing.js";

function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new InputError(`${label}无效`);
  return value as number;
}

function parseTiming(value: unknown): ScheduleTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("执行时间无效");
  const source = value as Record<string, unknown>;
  if (source.kind === "once") {
    const time = typeof source.at === "string" ? Date.parse(source.at) : Number.NaN;
    if (!Number.isFinite(time)) throw new InputError("执行时间无效");
    return { kind: "once", at: new Date(time).toISOString() };
  }
  const hour = integer(source.hour, 0, 23, "小时");
  const minute = integer(source.minute, 0, 59, "分钟");
  if (source.kind === "daily") return { kind: "daily", hour, minute };
  if (source.kind === "weekly") return { kind: "weekly", weekday: integer(source.weekday, 0, 6, "星期"), hour, minute };
  throw new InputError("执行时间无效");
}

export function parseScheduleInput(source: Record<string, unknown>): ScheduleInput {
  if (!SCHEDULE_TEMPLATES.includes(source.template as ScheduleTemplate)) throw new InputError("工作模板无效");
  const timezone = source.timezone === undefined ? DEFAULT_TIMEZONE : source.timezone;
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) throw new InputError("时区无效");
  return { template: source.template as ScheduleTemplate, timing: parseTiming(source.timing), timezone, enabled: source.enabled !== false };
}

export function parseScheduleVersion(value: unknown): number {
  return integer(value, 1, Number.MAX_SAFE_INTEGER, "版本号");
}
