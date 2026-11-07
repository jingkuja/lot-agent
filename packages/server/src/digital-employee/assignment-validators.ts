import { FAILURE_CHOICES, type AssignmentMode, type DecisionAnswer, type FailureChoice } from "./assignment-state.js";
import { InputError } from "./errors.js";

const MAX_GOAL = 8_000;
const MAX_ATTACHMENTS = 10;
const MAX_CREDITS = 100_000_000;
const MAX_SEARCH = 200;
export const ASSIGNMENT_PAGE = 30;
const MAX_PAGE = 100;
const MAX_ANSWER = 2_000;
const MAX_SUBTASKS_AT_ONCE = 50;
const MAX_SUBTASK_LIMIT = 10_000;
const MODES: readonly AssignmentMode[] = ["autonomous", "responsive"];
const STATUS_FILTERS = ["active", "paused", "succeeded", "failed", "cancelled"] as const;

export interface AssignmentAttachmentInput {
  assetId: string;
  filename: string;
}

function credits(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_CREDITS) throw new InputError("费用上限必须是大于 0 的数字");
  return parsed;
}

function attachments(value: unknown): AssignmentAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new InputError(`最多附 ${MAX_ATTACHMENTS} 个文件`);
  return value.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    if (typeof row.assetId !== "string" || !row.assetId) throw new InputError("附件无效");
    return { assetId: row.assetId, filename: typeof row.filename === "string" && row.filename.trim() ? row.filename.trim().slice(0, 300) : "附件" };
  });
}

export function parseCreateAssignment(payload: Record<string, unknown>) {
  const goal = typeof payload.goal === "string" ? payload.goal.trim() : "";
  const files = attachments(payload.attachments);
  if (!goal && !files.length) throw new InputError("告诉员工要做什么");
  if ([...goal].length > MAX_GOAL) throw new InputError(`任务内容最多 ${MAX_GOAL} 字`);
  const subtasks = subtaskGoals(payload.subtasks);
  const subtaskLimit = parseSubtaskLimit(payload);
  if (subtaskLimit !== null && subtasks.length > subtaskLimit) throw new InputError("子任务数量超过了你设的上限");
  if (payload.mode !== undefined && !MODES.includes(payload.mode as AssignmentMode)) throw new InputError("任务模式无效");
  return {
    goal,
    mode: (payload.mode ?? "autonomous") as AssignmentMode,
    attachments: files,
    modelId: typeof payload.modelId === "string" && payload.modelId.trim() ? payload.modelId.trim() : null,
    creditLimit: credits(payload.creditLimit),
    subtasks,
    subtaskLimit,
  };
}

function subtaskGoals(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InputError("子任务格式不对");
  const goals = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  if (goals.length > MAX_SUBTASKS_AT_ONCE) throw new InputError(`一次最多加 ${MAX_SUBTASKS_AT_ONCE} 个子任务`);
  return goals.map(subtaskGoal);
}

function subtaskGoal(goal: string): string {
  if ([...goal].length > MAX_GOAL) throw new InputError(`子任务内容最多 ${MAX_GOAL} 字`);
  return goal;
}

export function parseSubtask(payload: Record<string, unknown>): string {
  const goal = typeof payload.goal === "string" ? payload.goal.trim() : "";
  if (!goal) throw new InputError("写下这个子任务要做什么");
  return subtaskGoal(goal);
}

export function parseSubtaskLimit(payload: Record<string, unknown>): number | null {
  const value = payload.subtaskLimit;
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_SUBTASK_LIMIT) throw new InputError("子任务数量上限必须是大于 0 的整数");
  return parsed;
}

export function parseCreditLimit(payload: Record<string, unknown>): number | null {
  return credits(payload.creditLimit);
}

export function parseDecisionAnswer(payload: Record<string, unknown>): DecisionAnswer {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if ([...text].length > MAX_ANSWER) throw new InputError(`回答最多 ${MAX_ANSWER} 字`);
  if (payload.choice !== undefined && !FAILURE_CHOICES.includes(payload.choice as FailureChoice)) throw new InputError("选项无效");
  return { ...(payload.choice ? { choice: payload.choice as FailureChoice } : {}), ...(text ? { text } : {}) };
}

/** The id of the last event this device saw. */
export function parseEventCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d{1,18}$/.test(value)) throw new InputError("事件游标无效");
  return value;
}

/** Times arrive already in UTC: the browser works out what "today" means in its own timezone. */
function instant(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new InputError(`${label}无效`);
  return new Date(time).toISOString();
}

export function parseAssignmentList(query: Record<string, string | undefined>) {
  const status = query.status;
  if (status && !(STATUS_FILTERS as readonly string[]).includes(status)) throw new InputError("状态筛选无效");
  const limit = query.limit ? Number(query.limit) : ASSIGNMENT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new InputError("每页数量无效");
  const from = instant(query.from, "开始时间");
  const to = instant(query.to, "结束时间");
  if (from && to && from > to) throw new InputError("开始时间不能晚于结束时间");
  return {
    from, to, limit,
    q: query.q?.trim().slice(0, MAX_SEARCH) || undefined,
    status: status as typeof STATUS_FILTERS[number] | undefined,
    cursor: query.cursor || undefined,
    openBefore: instant(query.openBefore, "时间"),
  };
}
