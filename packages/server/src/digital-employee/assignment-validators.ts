import { InputError } from "./errors.js";

const MAX_GOAL = 8_000;
const MAX_ATTACHMENTS = 10;
const MAX_CREDITS = 100_000_000;
const MAX_SEARCH = 200;
export const ASSIGNMENT_PAGE = 30;
const MAX_PAGE = 100;
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
  return {
    goal,
    attachments: files,
    modelId: typeof payload.modelId === "string" && payload.modelId.trim() ? payload.modelId.trim() : null,
    creditLimit: credits(payload.creditLimit),
  };
}

export function parseCreditLimit(payload: Record<string, unknown>): number | null {
  return credits(payload.creditLimit);
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
