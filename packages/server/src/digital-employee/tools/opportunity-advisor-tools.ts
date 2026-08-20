import type { Tool, ToolContext, ToolResult } from "@lot-agent/core";
import type { DigitalEmployeeService } from "../service.js";
import { InputError } from "../errors.js";
import {
  parseActionResult,
  parseFollowUpActionPrepare,
  parseOutreachGenerate,
} from "../opportunity-validators.js";
import { parseDraftId, parseEntityId } from "../validators.js";
import { OPPORTUNITY_TYPES, OPPORTUNITY_VIEWS, type OpportunityView } from "../opportunity-types.js";
import {
  assertScope,
  confirmationContent,
  jsonResult,
  object,
  optionalString,
  sourceContext,
  toolError,
} from "./agent-tool-helpers.js";

const SCOPE = "opportunity-advisor";
const LABEL = "商机参谋";

/** Conversation tools for 商机参谋. Writes go through prepare → ask_user → commit. */
export function createOpportunityAdvisorTools(service: DigitalEmployeeService): Tool[] {
  const opportunities = service.opportunities;

  const searchQueue: Tool = {
    name: "search_customer_work_queue",
    description:
      "查询商机参谋今日经营队列、逾期行动、跟进中或待回填事项。只返回单个客户事项，不含客群营销。" +
      "回答“今天该跟谁”优先用 view=today；逾期未完成也包含在 today 中。",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: [...OPPORTUNITY_VIEWS] },
        query: { type: "string", description: "客户姓名或机构关键词" },
        profileId: { type: "string" },
      },
    },
    async execute(input, context) {
      return run(context, "查询经营队列失败", async (userId) => {
        const value = object(input ?? {});
        const view = (optionalString(value.view, 32, "view") ?? "today") as OpportunityView;
        if (!OPPORTUNITY_VIEWS.includes(view)) throw new InputError("view取值无效");
        const result = await opportunities.list(userId, {
          view,
          query: optionalString(value.query, 200, "query"),
          profileId: value.profileId === undefined ? undefined : parseEntityId(value.profileId, "profileId"),
        });
        return {
          view,
          summary: result.summary,
          total: result.total,
          hasProfiles: result.hasProfiles,
          items: result.items.slice(0, 20).map(queueItem),
          managementUrl: "/digital-employee/acquisition",
        };
      });
    },
  };

  const searchOpportunities: Tool = {
    name: "search_customer_opportunities",
    description: "查询尚未决定的单客户商机。采纳、稍后或忽略请使用 prepare_follow_up_action。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        opportunityType: { type: "string", enum: [...OPPORTUNITY_TYPES] },
        profileId: { type: "string" },
      },
    },
    async execute(input, context) {
      return run(context, "查询商机失败", async (userId) => {
        const value = object(input ?? {});
        const result = await opportunities.list(userId, {
          view: "pending",
          query: optionalString(value.query, 200, "query"),
          opportunityType: value.opportunityType as typeof OPPORTUNITY_TYPES[number] | undefined,
          profileId: value.profileId === undefined ? undefined : parseEntityId(value.profileId, "profileId"),
        });
        return {
          total: result.total,
          items: result.items.slice(0, 20).map(queueItem),
          managementUrl: "/digital-employee/acquisition",
        };
      });
    },
  };

  const businessContext: Tool = {
    name: "get_customer_business_context",
    description:
      "读取一位已确认客户的经营上下文：关系阶段、近期事实、待判断商机、跟进行动和最近话术。" +
      "必须先确定唯一 profileId；多位候选时用 ask_user 让用户选择。不返回联系方式。",
    parameters: {
      type: "object",
      properties: {
        profileId: { type: "string" },
        customerMention: { type: "string" },
      },
    },
    async execute(input, context) {
      return run(context, "读取客户经营上下文失败", async (userId) => {
        const value = object(input ?? {});
        const profileId = await resolveProfileId(service, userId, value, context);
        const result = await opportunities.getCustomerBusinessContext(userId, profileId);
        await service.rememberCurrentProfile(userId, context.conversationId, {
          id: result.profile.id,
          displayName: result.profile.displayName,
        }).catch(() => {});
        return result;
      });
    },
  };

  const prepareAction: Tool = {
    name: "prepare_follow_up_action",
    description:
      "准备创建、采纳、稍后、忽略、改期、取消或标记执行一次单客户行动。不直接改正式状态。" +
      "返回 needs_confirmation 时必须 ask_user，确认后再 commit_follow_up_action。" +
      "create 需要唯一客户；accept/snooze/dismiss 需要 opportunityId；reschedule/cancel/execute 需要 actionId。",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["create", "accept", "snooze", "dismiss", "reschedule", "cancel", "execute"] },
        customerMention: { type: "string" },
        profileId: { type: "string" },
        opportunityId: { type: "string" },
        actionId: { type: "string" },
        opportunityType: { type: "string", enum: [...OPPORTUNITY_TYPES] },
        title: { type: "string" },
        objective: { type: "string" },
        followUpMethod: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        scheduledAt: { type: "string", description: "ISO 时间" },
        resultCriteria: { type: "string" },
        productName: { type: "string" },
        reason: { type: "string" },
        snoozedUntil: { type: "string" },
        version: { type: "integer" },
      },
      required: ["operation"],
    },
    async execute(input, context) {
      return run(context, "准备跟进行动失败", async (userId) => {
        const parsed = parseFollowUpActionPrepare(input);
        if (parsed.operation === "create" && !parsed.profileId) {
          parsed.profileId = await resolveProfileId(service, userId, object(input ?? {}), context);
        }
        const draft = await opportunities.prepareFollowUpAction(userId, parsed, sourceContext(context));
        return confirmationContent(draft, "commit_follow_up_action");
      }, false);
    },
  };

  const commitAction: Tool = {
    name: "commit_follow_up_action",
    description: "提交 prepare_follow_up_action 产生的草稿。不得附加新字段。用户选择客户时传入对应 profileId。",
    parameters: {
      type: "object",
      properties: {
        draftId: { type: "string" },
        profileId: { type: "string" },
      },
      required: ["draftId"],
    },
    async execute(input, context) {
      return run(context, "提交跟进行动失败", async (userId) => {
        const value = object(input);
        return opportunities.commitFollowUpAction(
          userId,
          parseDraftId(value.draftId),
          value.profileId === undefined ? undefined : parseEntityId(value.profileId, "profileId")
        );
      });
    },
  };

  const prepareResult: Tool = {
    name: "prepare_follow_up_result",
    description:
      "准备回填一次已执行行动的结果、客户原话和下一步。不直接写记录。" +
      "行动必须处于待回填。确认后调用 commit_follow_up_result。",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        outcome: { type: "string", enum: ["no_response", "replied", "interested", "scheduled", "won", "rejected", "service_needed"] },
        customerQuote: { type: "string" },
        note: { type: "string" },
        nextAction: { type: "string" },
        nextActionAt: { type: "string" },
        confirmedRelationshipStage: { type: "string", enum: ["lead", "prospect", "customer", "inactive", "lost"] },
      },
      required: ["actionId", "outcome"],
    },
    async execute(input, context) {
      return run(context, "准备结果回填失败", async (userId) => {
        const value = object(input);
        const draft = await opportunities.prepareFollowUpResult(
          userId,
          parseEntityId(value.actionId, "actionId"),
          parseActionResult(value),
          sourceContext(context)
        );
        return confirmationContent(draft, "commit_follow_up_result");
      }, false);
    },
  };

  const commitResult: Tool = {
    name: "commit_follow_up_result",
    description: "提交 prepare_follow_up_result 产生的草稿。不得附加新字段。",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交结果回填失败", async (userId) =>
        opportunities.commitFollowUpResult(userId, parseDraftId(object(input).draftId)));
    },
  };

  const generateOutreach: Tool = {
    name: "generate_individual_outreach",
    description:
      "为当前单客户行动或已确认客户生成个性化联系、维护或销售话术，并保存到该行动/客户。" +
      "不得用于客群广告。需要 itemId（行动或商机）或唯一 profileId。",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "行动 ID 或商机 ID" },
        profileId: { type: "string" },
        customerMention: { type: "string", description: "没有 itemId 时用于匹配唯一客户" },
        intent: { type: "string", enum: ["maintenance", "follow_up", "sales"] },
        channel: { type: "string", enum: ["wechat", "phone", "email", "visit"] },
        message: { type: "string", description: "用户对语气、长度或目标的要求" },
      },
      required: ["message"],
    },
    async execute(input, context) {
      return run(context, "生成个性化话术失败", async (userId) => {
        const value = object(input);
        const itemId = optionalString(value.itemId, 80, "itemId");
        const profileId = value.profileId === undefined && !itemId
          ? await resolveProfileId(service, userId, value, context)
          : value.profileId === undefined ? undefined : parseEntityId(value.profileId, "profileId");
        const draft = await opportunities.generateOutreach(userId, parseOutreachGenerate({
          ...value, itemId, profileId, intent: value.intent ?? "follow_up",
        }));
        return {
          outreach: draft,
          message: "已生成个性化话术。复制或改写后，只有用户明确说已使用才调用 mark_individual_outreach_used。",
          managementUrl: "/digital-employee/acquisition",
        };
      });
    },
  };

  const rewriteOutreach: Tool = {
    name: "rewrite_individual_outreach",
    description: "按用户要求改写已生成的单客户话术，例如更短、更像熟人、不要提价格。保存为新版本。",
    parameters: {
      type: "object",
      properties: {
        outreachId: { type: "string" },
        instruction: { type: "string" },
      },
      required: ["outreachId", "instruction"],
    },
    async execute(input, context) {
      return run(context, "改写话术失败", async (userId) => {
        const value = object(input);
        const draft = await opportunities.rewriteOutreach(
          userId,
          parseEntityId(value.outreachId, "outreachId"),
          optionalString(value.instruction, 2_000, "instruction") ?? ""
        );
        return { outreach: draft, managementUrl: "/digital-employee/acquisition" };
      });
    },
  };

  const markUsed: Tool = {
    name: "mark_individual_outreach_used",
    description: "在用户明确表示已经使用或发送某条话术后，标记该版本为已使用。不自动发送消息。",
    parameters: {
      type: "object",
      properties: { outreachId: { type: "string" } },
      required: ["outreachId"],
    },
    async execute(input, context) {
      return run(context, "标记话术使用失败", async (userId) => ({
        outreach: await opportunities.markOutreachUsed(userId, parseEntityId(object(input).outreachId, "outreachId")),
        message: "已标记实际使用。生成话术本身不等于已联系客户。",
        managementUrl: "/digital-employee/acquisition",
      }));
    },
  };

  return [
    searchQueue, searchOpportunities, businessContext,
    prepareAction, commitAction, prepareResult, commitResult,
    generateOutreach, rewriteOutreach, markUsed,
  ];
}

async function resolveProfileId(
  service: DigitalEmployeeService,
  userId: string,
  value: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  if (value.profileId !== undefined) return parseEntityId(value.profileId, "profileId");
  const mention = optionalString(value.customerMention, 200, "customerMention");
  if (!mention) throw new InputError("请提供客户称呼或 profileId");
  const candidates = await service.resolveCustomerCandidates(userId, mention, context.conversationId);
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length === 0) throw new InputError(`未找到“${mention}”的客户画像，请先在客户画像中建档`);
  throw new InputError(
    `“${mention}”匹配到多位客户，请先调用 ask_user 让用户选择后再传入 profileId。候选：` +
    candidates.map((item) => `${item.displayName}${item.customerRegion ? `（${item.customerRegion}）` : ""} | profileId: ${item.id}`).join("；")
  );
}

function queueItem(item: {
  id: string; view: string; opportunityId: string; actionId: string | null; profileId: string;
  customerName: string; organization: string | null; relationshipStage: string; opportunityType: string;
  source: string; title: string; objective: string; followUpMethod: string | null; scheduledAt: string | null;
  priority: string; reason: string; readiness: string; status: string; overdue: boolean; productName: string | null;
}) {
  return {
    id: item.id, view: item.view, opportunityId: item.opportunityId, actionId: item.actionId,
    profileId: item.profileId, customerName: item.customerName, organization: item.organization,
    relationshipStage: item.relationshipStage, opportunityType: item.opportunityType, source: item.source,
    title: item.title, objective: item.objective, followUpMethod: item.followUpMethod,
    scheduledAt: item.scheduledAt, priority: item.priority, reason: item.reason, readiness: item.readiness,
    status: item.status, overdue: item.overdue, productName: item.productName,
    detailUrl: "/digital-employee/acquisition",
  };
}

async function run(
  context: ToolContext,
  prefix: string,
  operation: (userId: string) => Promise<unknown>,
  asJson = true
): Promise<ToolResult> {
  try {
    assertScope(context, SCOPE, LABEL);
    const value = await operation(context.userId ?? "default");
    return typeof value === "string" && !asJson ? { content: value } : jsonResult(value);
  } catch (error) {
    return toolError(prefix, error);
  }
}
