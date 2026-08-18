import type { Tool, ToolContext, ToolResult } from "@lot-agent/core";
import type { DigitalEmployeeService } from "../service.js";
import { InputError } from "../errors.js";
import { parseCaptureInput, parseOptionalJourneyStage, parseOptionalProfileId, parseDraftId } from "../validators.js";

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed", "unknown"] },
    satisfaction: { type: "string", enum: ["satisfied", "neutral", "dissatisfied", "unknown"] },
    health: { type: "string", enum: ["healthy", "watch", "at_risk"] },
    relationshipStage: { type: "string", enum: ["lead", "prospect", "customer", "inactive", "lost"] },
    journeyStage: { type: "string", enum: ["unknown", "evaluating", "trial", "purchased", "using", "renewal", "paused", "lost", "churned"] },
    needs: { type: "array", items: {} },
    objections: { type: "array", items: {} },
    currentIssues: { type: "array", items: {} },
  },
};

const PREPARE_PARAMETERS = {
  type: "object",
  properties: {
    customerMention: { type: "string", description: "用户原话里的客户称呼，如“李姐”或“张总”" },
    eventType: {
      type: "string",
      enum: ["contact", "requirement", "purchase_intent", "trial", "purchase", "product_feedback", "complaint", "delivery", "renewal", "churn", "note"],
    },
    productName: { type: "string" },
    occurredAt: { type: "string", description: "只有原话明确给出时才填写 ISO 时间" },
    facts: FACTS_SCHEMA,
    proposedStatePatch: FACTS_SCHEMA,
    uncertainties: { type: "array", items: { type: "string" }, maxItems: 8 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["customerMention", "eventType"],
};

/**
 * Prepare and commit are deliberately separate. The model may suggest facts,
 * but it never supplies the source text, user id or a cross-user profile id;
 * the server receives those only from ToolContext / identity resolution.
 */
export function createCustomerCaptureTools(service: DigitalEmployeeService): Tool[] {
  const prepare: Tool = {
    name: "prepare_customer_capture",
    description:
      "当用户在记录客户、潜客、购买、试用、投诉、反馈或沟通结果时调用。根据当前用户消息匹配客户并创建可提交的采集草稿。" +
      "它不直接写入画像；若返回 needs_clarification，必须使用 ask_user 询问其中给出的一个问题后，再调用 commit_customer_capture。" +
      "不要把客户事实写入用户记忆来替代此工具。",
    parameters: PREPARE_PARAMETERS,
    async execute(input, context): Promise<ToolResult> {
      try {
        const prepared = await service.prepareCustomerCapture(
          context.userId ?? "default",
          parseCaptureInput(input),
          sourceContext(context)
        );
        if (prepared.status === "ready") {
          return {
            content:
              `客户记录草稿已准备好。draftId: ${prepared.draftId}\n` +
              `已唯一匹配：${prepared.profile?.displayName ?? "客户"}（profileId: ${prepared.profile?.id ?? ""}）。\n` +
              "现在立即调用 commit_customer_capture，传入该 draftId；不要自行改写或重复输入用户原文。",
          };
        }
        const candidates = prepared.candidates
          .map((candidate) => `- ${candidate.displayName}${candidate.customerRegion ? `（${candidate.customerRegion}）` : ""} | profileId: ${candidate.id}`)
          .join("\n");
        return {
          content:
            `客户记录需要用户确认。draftId: ${prepared.draftId}\n` +
            `确认类型：${prepared.clarification?.kind}\n` +
            `请调用 ask_user，question 必须为：${prepared.clarification?.question ?? "请确认客户信息"}\n` +
            `options 必须为：${JSON.stringify(prepared.clarification?.options ?? [])}\n` +
            (candidates ? `候选映射（仅用于用户回答后调用 commit_customer_capture）：\n${candidates}\n` : "") +
            "不要提交草稿，直到用户给出明确回答。",
        };
      } catch (error) {
        return toolError(error);
      }
    },
  };

  const commit: Tool = {
    name: "commit_customer_capture",
    description:
      "提交 prepare_customer_capture 已创建的客户采集草稿。仅在草稿 ready 时立即调用，或在 ask_user 收到明确回答后调用。" +
      "profileId 只能使用 prepare 返回的候选 ID；新客户需传 createProfile；产品阶段歧义需传 confirmedJourneyStage。" +
      "成功后会保存用户原文快照、结构化抽取版本和允许的动态状态变化。",
    parameters: {
      type: "object",
      properties: {
        draftId: { type: "string" },
        profileId: { type: "string" },
        createProfile: {
          type: "object",
          properties: { displayName: { type: "string" } },
        },
        confirmedJourneyStage: {
          type: "string",
          enum: ["unknown", "evaluating", "trial", "purchased", "using", "renewal", "paused", "lost", "churned"],
        },
      },
      required: ["draftId"],
    },
    async execute(input, context): Promise<ToolResult> {
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("提交参数无效");
        const value = input as Record<string, unknown>;
        const create = value.createProfile;
        if (create !== undefined && (!create || typeof create !== "object" || Array.isArray(create))) {
          throw new InputError("createProfile无效");
        }
        let displayName: string | undefined;
        if (create) {
          const candidate = (create as Record<string, unknown>).displayName;
          if (typeof candidate === "string") displayName = candidate;
        }
        const result = await service.commitCustomerCapture(
          context.userId ?? "default",
          {
            draftId: parseDraftId(value.draftId),
            profileId: parseOptionalProfileId(value.profileId),
            createProfile: create ? { displayName } : undefined,
            confirmedJourneyStage: parseOptionalJourneyStage(value.confirmedJourneyStage),
          },
          sourceContext(context)
        );
        return { content: formatCommit(result) };
      } catch (error) {
        return toolError(error);
      }
    },
  };

  return [prepare, commit];
}

function sourceContext(context: ToolContext) {
  return {
    conversationId: context.conversationId,
    sourceMessageId: context.sourceMessageId,
    sourceText: context.sourceText,
    modelId: context.modelId,
  };
}

function formatCommit(result: Awaited<ReturnType<DigitalEmployeeService["commitCustomerCapture"]>>): string {
  const changed = result.appliedFields.length ? result.appliedFields.join("、") : "已保存原始记录";
  const skipped = result.skippedFields.length ? `；未覆盖人工锁定字段：${result.skippedFields.join("、")}` : "";
  return (
    `${result.alreadyApplied ? "该客户记录此前已提交" : "已记录"}到「${result.profile.displayName}」的客户画像。` +
    `更新：${changed}${skipped}。\n` +
    `[查看画像](/digital-employee/profiles/${result.profile.id})`
  );
}

function toolError(error: unknown): ToolResult {
  return {
    content: `客户画像记录失败：${error instanceof Error ? error.message : "服务暂时不可用"}`,
    isError: true,
    errorKind: error instanceof InputError ? "validation" : "unknown",
  };
}
