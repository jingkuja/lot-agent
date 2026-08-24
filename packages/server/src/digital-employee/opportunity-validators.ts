import { InputError } from "./errors.js";
import {
  ACTION_OUTCOMES, FOLLOW_UP_ACTION_OPERATIONS, OPPORTUNITY_TYPES, OPPORTUNITY_VIEWS, OUTREACH_CHANNELS, PRIORITY_VALUES, READINESS_VALUES, TALK_TRACK_INTENTS,
  type ActionResultInput, type ActionUpdateInput, type FollowUpActionPrepareInput, type ManualActionInput, type OpportunityDecisionInput, type OpportunityListFilters,
  type OutreachGenerateInput, type TalkTrackRequest,
} from "./opportunity-types.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("请求体必须是对象");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 1_000, required = false): string | undefined {
  if (value === undefined) { if (required) throw new InputError(`${label}不能为空`); return undefined; }
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw new InputError(`${label}格式无效`);
  return value.trim();
}

function choice<T extends readonly string[]>(value: unknown, choices: T, label: string, required = false): T[number] | undefined {
  if (value === undefined || value === "") { if (required) throw new InputError(`${label}不能为空`); return undefined; }
  if (typeof value !== "string" || !choices.includes(value)) throw new InputError(`${label}取值无效`);
  return value as T[number];
}

function date(value: unknown, label: string, required = false): string | undefined {
  if (value === undefined || value === "") { if (required) throw new InputError(`${label}不能为空`); return undefined; }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new InputError(`${label}时间无效`);
  return new Date(value).toISOString();
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new InputError("version无效");
  return value;
}

export function parseOpportunityList(query: Record<string, string>): OpportunityListFilters {
  return {
    view: choice(query.view, OPPORTUNITY_VIEWS, "view") ?? "pending",
    readiness: choice(query.readiness, READINESS_VALUES, "readiness"),
    priority: choice(query.priority, PRIORITY_VALUES, "priority"),
    opportunityType: choice(query.opportunityType, OPPORTUNITY_TYPES, "opportunityType"),
    relationshipStage: text(query.relationshipStage, "relationshipStage", 30),
    product: text(query.product, "product", 200),
    suggestedFrom: date(query.suggestedFrom, "suggestedFrom"),
    suggestedTo: date(query.suggestedTo, "suggestedTo"),
    query: text(query.query, "query", 200),
    profileId: text(query.profileId, "profileId", 80),
  };
}

export function parseOpportunityDecision(value: unknown): OpportunityDecisionInput {
  const source = object(value);
  const decision = choice(source.decision, ["accept", "snooze", "dismiss"] as const, "decision", true)!;
  const reason = text(source.reason, "reason", 500);
  const snoozedUntil = date(source.snoozedUntil, "snoozedUntil", decision === "snooze");
  if (decision === "snooze" && snoozedUntil! <= new Date().toISOString()) throw new InputError("恢复日期必须晚于当前时间");
  if (decision === "dismiss" && !reason) throw new InputError("忽略商机时请选择原因");
  return { decision, reason, snoozedUntil,
    scheduledAt: date(source.scheduledAt, "scheduledAt"), followUpMethod: text(source.followUpMethod, "followUpMethod", 32),
    objective: text(source.objective, "objective", 2_000), resultCriteria: text(source.resultCriteria, "resultCriteria", 500) };
}

export function parseActionUpdate(value: unknown): ActionUpdateInput {
  const source = object(value);
  const operation = choice(source.operation, ["reschedule", "cancel", "execute"] as const, "operation", true)!;
  return { operation, version: version(source.version), scheduledAt: date(source.scheduledAt, "scheduledAt", operation === "reschedule"),
    reason: text(source.reason, "reason", 500) };
}

export function parseActionResult(value: unknown): ActionResultInput {
  const source = object(value);
  const nextAction = text(source.nextAction, "nextAction", 1_000);
  const nextActionAt = date(source.nextActionAt, "nextActionAt");
  if ((nextAction && !nextActionAt) || (!nextAction && nextActionAt)) throw new InputError("下一步行动和预计时间需要同时填写");
  return {
    outcome: choice(source.outcome, ACTION_OUTCOMES, "outcome", true)!,
    customerQuote: text(source.customerQuote, "customerQuote", 2_000), note: text(source.note, "note", 3_000),
    nextAction, nextActionAt,
    confirmedRelationshipStage: choice(source.confirmedRelationshipStage, ["lead", "prospect", "customer", "inactive", "lost"] as const, "confirmedRelationshipStage"),
  };
}

export function parseCreateAction(value: unknown): ManualActionInput {
  const source = object(value);
  const profileId = text(source.profileId, "profileId", 100, true)!;
  const opportunityType = choice(source.opportunityType, OPPORTUNITY_TYPES, "opportunityType", true)!;
  return {
    profileId,
    opportunityType,
    title: text(source.title, "title", 300, true)!,
    objective: text(source.objective, "objective", 2_000, true)!,
    followUpMethod: text(source.followUpMethod, "followUpMethod", 32),
    priority: choice(source.priority, PRIORITY_VALUES, "priority", true)!,
    scheduledAt: date(source.scheduledAt, "scheduledAt", true)!,
    resultCriteria: text(source.resultCriteria, "resultCriteria", 500),
    productKey: text(source.productKey, "productKey", 160),
    productName: text(source.productName, "productName", 200),
  };
}

export function parseTalkTrackRequest(value: unknown): TalkTrackRequest {
  const source = object(value);
  const rawHistory = source.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > 12) throw new InputError("话术对话历史格式无效");
  const history = rawHistory.map((entry) => {
    const item = object(entry);
    return {
      role: choice(item.role, ["user", "assistant"] as const, "history.role", true)!,
      content: text(item.content, "history.content", 4_000, true)!,
    };
  });
  return {
    intent: choice(source.intent, TALK_TRACK_INTENTS, "intent", true)!,
    message: text(source.message, "message", 2_000, true)!,
    history,
    modelId: text(source.modelId, "modelId", 200),
  };
}

export function parseFollowUpActionPrepare(value: unknown): FollowUpActionPrepareInput {
  const source = object(value);
  const operation = choice(source.operation, FOLLOW_UP_ACTION_OPERATIONS, "operation", true)!;
  const input: FollowUpActionPrepareInput = {
    operation,
    customerMention: text(source.customerMention, "customerMention", 200),
    profileId: text(source.profileId, "profileId", 80),
    opportunityId: text(source.opportunityId, "opportunityId", 80),
    actionId: text(source.actionId, "actionId", 80),
    opportunityType: choice(source.opportunityType, OPPORTUNITY_TYPES, "opportunityType"),
    title: text(source.title, "title", 300),
    objective: text(source.objective, "objective", 2_000),
    followUpMethod: text(source.followUpMethod, "followUpMethod", 32),
    priority: choice(source.priority, PRIORITY_VALUES, "priority"),
    scheduledAt: date(source.scheduledAt, "scheduledAt"),
    resultCriteria: text(source.resultCriteria, "resultCriteria", 500),
    productName: text(source.productName, "productName", 200),
    reason: text(source.reason, "reason", 500),
    snoozedUntil: date(source.snoozedUntil, "snoozedUntil"),
    version: source.version === undefined ? undefined : version(source.version),
  };
  if (operation === "create" && !input.profileId && !input.customerMention) throw new InputError("创建行动需要客户称呼或 profileId");
  if (operation === "create" && !input.title) throw new InputError("title不能为空");
  if (operation === "create" && !input.objective) throw new InputError("objective不能为空");
  if (operation === "create" && !input.opportunityType) throw new InputError("opportunityType不能为空");
  if (operation === "create" && !input.priority) throw new InputError("priority不能为空");
  if (operation === "create" && !input.scheduledAt) throw new InputError("scheduledAt不能为空");
  if ((operation === "accept" || operation === "snooze" || operation === "dismiss") && !input.opportunityId) {
    throw new InputError("处理商机需要 opportunityId");
  }
  if ((operation === "reschedule" || operation === "cancel" || operation === "execute") && !input.actionId) {
    throw new InputError("更新行动需要 actionId");
  }
  if (operation === "reschedule" && !input.scheduledAt) throw new InputError("改期需要 scheduledAt");
  if (operation === "snooze" && !input.snoozedUntil) throw new InputError("稍后处理需要恢复时间");
  if (operation === "dismiss" && !input.reason) throw new InputError("忽略商机时请选择原因");
  return input;
}

export function parseOutreachGenerate(value: unknown): OutreachGenerateInput {
  const source = object(value);
  const history = parseTalkTrackRequest({
    intent: source.intent ?? "follow_up",
    message: source.message,
    history: source.history ?? [],
  });
  const itemId = text(source.itemId, "itemId", 80);
  const profileId = text(source.profileId, "profileId", 80);
  if (!itemId && !profileId) throw new InputError("生成话术需要 itemId 或 profileId");
  return {
    itemId,
    profileId,
    intent: history.intent,
    channel: choice(source.channel, OUTREACH_CHANNELS, "channel") ?? "wechat",
    message: history.message,
    history: history.history,
  };
}

export function parseOpportunitySettings(value: unknown) {
  const source = object(value);
  if (typeof source.enabled !== "boolean") throw new InputError("enabled格式无效");
  const timezone = text(source.timezone, "timezone", 80, true)!;
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(); } catch { throw new InputError("timezone无效"); }
  const dailyRunTime = text(source.dailyRunTime, "dailyRunTime", 5, true)!;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyRunTime)) throw new InputError("dailyRunTime无效");
  return { enabled: source.enabled, timezone, dailyRunTime, version: version(source.version) };
}
