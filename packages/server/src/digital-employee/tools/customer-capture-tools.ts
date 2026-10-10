import { toolError as failureResult } from "./agent-tool-helpers.js";
import type { Tool, ToolContext, ToolResult } from "@lot-agent/core";
import type { DigitalEmployeeService } from "../service.js";
import { InputError, ProductSelectionRequiredError } from "../errors.js";
import { parseCaptureInput, parseOptionalJourneyStage, parseOptionalProfileId, parseDraftId, parseEntityId } from "../validators.js";

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
    customerMention: { type: "string", description: "Customer name or form of address exactly as stated by the user." },
    eventType: {
      type: "string",
      enum: ["contact", "requirement", "purchase_intent", "trial", "purchase", "product_feedback", "complaint", "delivery", "renewal", "churn", "note"],
    },
    productName: {
      type: "string",
      description:
        "Product/service named in the user's message. Inquiry about, interest in, trial/purchase of or concern over X's price/threshold requires productName=X. Preserve the original name even without a marketing match so the server can request confirmation.",
    },
    marketingProductId: {
      type: "string",
      description:
        "Product ID only after a unique search_marketing_materials match. Otherwise pass productName without guessing an ID.",
    },
    occurredAt: { type: "string", description: "ISO timestamp only when explicitly supplied by the user." },
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
      "Capture customer/prospect communications, purchases, trials, complaints, feedback or outcomes. Resolve the customer from the current message and prepare a draft. Extract all supported eventType, productName, facts (needs/objections/currentIssues/journeyStage/relationshipStage/sentiment/satisfaction/health) and proposedStatePatch in the first call to minimize clarification. Search marketing materials first when a product is involved; pass its ID and canonical name only on a unique match. Inquiry, interest or hesitation over pricing/thresholds still require productName. Without a match retain the original name; the tool offers existing/new/no-association choices. This does not write the profile. needs_clarification requires asking the supplied question with ask_user before commit_customer_capture. Never substitute user memory for this tool.",
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
              `Customer capture draft ready. draftId: ${prepared.draftId}\n` +
              `Unique match: ${prepared.profile?.displayName ?? "客户"}（profileId: ${prepared.profile?.id ?? ""}）。\n` +
              "Call commit_customer_capture immediately with this draftId. Do not rewrite or repeat the original user text.",
          };
        }
        const candidates = prepared.candidates
          .map((candidate) => `- ${candidate.displayName}${candidate.customerRegion ? `（${candidate.customerRegion}）` : ""} | profileId: ${candidate.id}`)
          .join("\n");
        const productCandidates = (prepared.productCandidates ?? [])
          .map((candidate) => `- ${candidate.name} | marketingProductId: ${candidate.id}`)
          .join("\n");
        return {
          content:
            `客户记录User confirmation required. draftId: ${prepared.draftId}\n` +
            `Confirmation type: ${prepared.clarification?.kind}\n` +
            `Call ask_user. Translate this question into the user's language without changing its meaning: ${prepared.clarification?.question ?? "Please confirm the customer details"}\n` +
            `Translate these options into the user's language, preserving order, meaning and candidate mapping: ${JSON.stringify(prepared.clarification?.options ?? [])}\n` +
            (candidates ? `Candidate mapping (only for commit_customer_capture after the user answers): \n${candidates}\n` : "") +
            (productCandidates ? `Product candidate mapping: \n${productCandidates}\n` : "") +
            (prepared.clarification?.kind === "marketing_product"
              ? `Set allowFreeText=false in ask_user. For an existing product pass marketingProductId; for adding a new product pass createMarketingProduct=true; for explicitly no association pass skipProduct=true.\n`
              : "") +
            "Do not commit until the user gives an explicit answer.",
        };
      } catch (error) {
        return toolError(error);
      }
    },
  };

  const commit: Tool = {
    name: "commit_customer_capture",
    description:
      "Commit a prepare_customer_capture draft immediately only when ready, or after an explicit ask_user answer. profileId must come from the returned candidates; new customers require createProfile; ambiguous product stage requires confirmedJourneyStage. Product ambiguity allows exactly one of a candidate marketingProductId, createMarketingProduct=true, or skipProduct=true. Saves the original-message snapshot, structured extraction version and permitted state changes.",
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
        marketingProductId: { type: "string", description: "Candidate marketing product ID returned by prepare." },
        createMarketingProduct: { type: "boolean", description: "True only if the user explicitly chooses to add the original product name to marketing materials." },
        skipProduct: { type: "boolean", description: "True only if the user explicitly chooses no product association for this capture." },
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
            marketingProductId: value.marketingProductId === undefined
              ? undefined
              : parseEntityId(value.marketingProductId, "marketingProductId"),
            createMarketingProduct: value.createMarketingProduct === true,
            skipProduct: value.skipProduct === true,
          },
          sourceContext(context)
        );
        return { content: formatCommit(result) };
      } catch (error) {
        if (error instanceof ProductSelectionRequiredError) {
          const value = input as Record<string, unknown>;
          return productSelectionResult(parseDraftId(value.draftId), error);
        }
        return toolError(error);
      }
    },
  };

  return [prepare, commit];
}

function productSelectionResult(draftId: string, error: ProductSelectionRequiredError): ToolResult {
  const options = [
    ...error.candidates.map((candidate) => candidate.name),
    `将“${error.productName}”添加为新产品`,
    "本次不关联产品",
  ];
  const mapping = error.candidates
    .map((candidate) => `- ${candidate.name} | marketingProductId: ${candidate.id}`)
    .join("\n");
  return {
    content:
      `Customer identity confirmed; product association still requires confirmation. draftId: ${draftId}\n` +
      `Call ask_user. Translate this question into the user's language without changing its meaning: Which marketing product should "${error.productName}" be associated with?\n` +
      `Translate these options into the user's language, preserving order, meaning and candidate mapping: ${JSON.stringify(options)}\n` +
      "allowFreeText must be false.\n" +
      (mapping ? `Product candidate mapping: \n${mapping}\n` : "") +
      "After selecting an existing product call commit_customer_capture again with marketingProductId. " +
      "For adding a new product pass createMarketingProduct=true; for no association pass skipProduct=true. " +
      "If the identity was already confirmed, include the same profileId or createProfile again.",
  };
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
  return failureResult("客户信息处理失败", error);
}
