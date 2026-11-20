import { parseCreateAssignment } from "./assignment-validators.js";
import type { AssignmentScheduleTiming, AssignmentIntervalUnit } from "./assignment-schedule-timing.js";
import { InputError } from "./errors.js";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "./schedule-timing.js";

const UNITS: readonly AssignmentIntervalUnit[] = ["minutes", "hours", "days"];
const MAX_INTERVAL = 10_000;

function instant(value: unknown): string {
  // Never interpret a local time in the API server's timezone; the browser sends an explicit UTC instant.
  const iso = typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) throw new InputError("执行时间无效");
  return new Date(parsed).toISOString();
}

function timing(value: unknown): AssignmentScheduleTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("执行时间无效");
  const source = value as Record<string, unknown>;
  if (source.kind === "once") return { kind: "once", at: instant(source.at) };
  if (source.kind !== "interval" || !UNITS.includes(source.unit as AssignmentIntervalUnit)) throw new InputError("执行时间无效");
  if (!Number.isInteger(source.every) || (source.every as number) < 1 || (source.every as number) > MAX_INTERVAL) {
    throw new InputError("重复间隔必须是大于 0 的整数");
  }
  return {
    kind: "interval", startAt: instant(source.startAt), every: source.every as number, unit: source.unit as AssignmentIntervalUnit,
  };
}

export function parseAssignmentScheduleInput(payload: Record<string, unknown>) {
  const timezone = payload.timezone === undefined ? DEFAULT_TIMEZONE : payload.timezone;
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) throw new InputError("时区无效");
  return { assignment: parseCreateAssignment(payload), timing: timing(payload.timing), timezone };
}
