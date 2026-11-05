import { InputError } from "./errors.js";

export const DEFAULT_EMPLOYEE_NAME = "小灵";
const MAX_LENGTH = 20;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Count characters, not UTF-16 units, so the limit matches the database check. */
export function parseEmployeeName(value: unknown): string {
  if (typeof value !== "string") throw new InputError("员工名字无效");
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_LENGTH || CONTROL_CHARACTER.test(name)) {
    throw new InputError("员工名字需要 1–20 个字，且不能换行");
  }
  return name;
}
