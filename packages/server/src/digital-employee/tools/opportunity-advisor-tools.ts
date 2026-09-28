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
const LABEL = "商机雷达";

/** Conversation tools for 商机雷达. Writes go through prepare → ask_user → commit. */
export function createOpportunityAdvisorTools(service: DigitalEmployeeService): Tool[] {
  const opportunities = service.opportunities;

  const searchQueue: Tool = {
    name: "search_customer_work_queue",
    description:
      "Search Opportunity Radar's daily work queue, overdue actions, ongoing follow-ups or outcomes awaiting entry. Only individual-customer items; no cohort marketing. Use view=today for who to contact today, including unfinished overdue actions.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: [...OPPORTUNITY_VIEWS] },
        query: { type: "string", description: "Customer name or organization keyword." },
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
    description: "Search undecided individual-customer opportunities. Use prepare_follow_up_action to accept, snooze or dismiss.",
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
      "Read one confirmed customer's business context: relationship stage, recent facts, undecided opportunities, follow-up actions and recent scripts. First resolve a unique profileId; ask_user when multiple candidates exist. No contact details are returned.",
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
      "Prepare creation, acceptance, snoozing, dismissal, rescheduling, cancellation or execution of an individual-customer action without changing official state. needs_confirmation requires ask_user before commit_follow_up_action. create requires a unique customer; accept/snooze/dismiss require opportunityId; reschedule/cancel/execute require actionId.",
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
        scheduledAt: { type: "string", description: "ISO timestamp." },
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
    description: "Commit a draft from prepare_follow_up_action. Do not add new fields. Pass the profileId corresponding to the user's selected customer.",
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
      "Prepare an executed action's outcome, customer quote and next step without writing the record. The action must be awaiting an outcome. After confirmation call commit_follow_up_result.",
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
    description: "Commit a draft from prepare_follow_up_result. Do not add new fields.",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交结果回填失败", async (userId) =>
        opportunities.commitFollowUpResult(userId, parseDraftId(object(input).draftId)));
    },
  };

  const generateOutreach: Tool = {
    name: "generate_individual_outreach",
    description:
      "Generate and save a personalized contact, maintenance or sales script for one customer/action. Never use for cohort advertising. Requires itemId (action/opportunity) or a unique profileId.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Action ID or opportunity ID." },
        profileId: { type: "string" },
        customerMention: { type: "string", description: "Identify one customer when itemId is absent." },
        intent: { type: "string", enum: ["maintenance", "follow_up", "sales"] },
        channel: { type: "string", enum: ["wechat", "phone", "email", "visit"] },
        message: { type: "string", description: "User requirements for tone, length or objective." },
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
          message: "Personalized script generated. Call mark_individual_outreach_used only after the user explicitly says it was used, not merely copied or rewritten.",
          managementUrl: "/digital-employee/acquisition",
        };
      });
    },
  };

  const rewriteOutreach: Tool = {
    name: "rewrite_individual_outreach",
    description: "Rewrite an existing individual-customer script as requested, for example shorter, more familiar or without prices. Save a new version.",
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
    description: "Mark a script version used only after the user explicitly says it was used or sent. Never send messages automatically.",
    parameters: {
      type: "object",
      properties: { outreachId: { type: "string" } },
      required: ["outreachId"],
    },
    async execute(input, context) {
      return run(context, "标记话术使用失败", async (userId) => ({
        outreach: await opportunities.markOutreachUsed(userId, parseEntityId(object(input).outreachId, "outreachId")),
        message: "Marked as actually used. Generating a script alone does not mean the customer was contacted.",
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
    `Multiple customers match "${mention}". First use ask_user to select one, then pass profileId. Candidates: ` +
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
