import { toolError as failureResult } from "./agent-tool-helpers.js";
import type { Tool, ToolContext, ToolResult } from "@lot-agent/core";
import type { DigitalEmployeeService } from "../service.js";
import type { Health, ProfileChangeInput, RelationshipStage } from "../types.js";
import { InputError } from "../errors.js";
import { parseDraftId, parseEntityId } from "../validators.js";

const RELATIONSHIP_ENUM = ["lead", "prospect", "customer", "inactive", "lost"];
const HEALTH_ENUM = ["healthy", "watch", "at_risk"];

export function createCustomerProfileTools(service: DigitalEmployeeService): Tool[] {
  const search: Tool = {
    name: "search_customer_profiles",
    effect: "read",
    description:
      "Search or count the current account's customer profiles by name/alias, relationship, health or tags. total is the database match count; items is only the current page. Use total for counts. No contact details are returned.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Customer name, form of address or alias keyword." },
        relationshipStage: { type: "string", enum: RELATIONSHIP_ENUM },
        health: { type: "string", enum: HEALTH_ENUM },
        tag: { type: "string" },
        page: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    async execute(input, context) {
      try {
        const value = object(input);
        const result = await service.searchProfilesForAgent(context.userId ?? "default", {
          query: optionalString(value.query, 200),
          relationshipStage: value.relationshipStage as RelationshipStage | undefined,
          health: value.health as Health | undefined,
          tag: optionalString(value.tag, 80),
          page: optionalInteger(value.page, 1, 100_000),
          limit: optionalInteger(value.limit, 1, 20),
        });
        return {
          content: JSON.stringify({
            total: result.total,
            page: result.page,
            limit: result.limit,
            items: result.items.map((profile) => ({
              id: profile.id,
              displayName: profile.displayName,
              aliases: profile.aliases,
              customerRegion: profile.customerRegion,
              relationshipStage: profile.relationshipStage,
              overallHealth: profile.overallHealth,
              tags: profile.tags,
              summary: profile.summary,
              detailUrl: `/digital-employee/profiles/${profile.id}`,
            })),
          }),
        };
      } catch (error) {
        return toolError("查询客户画像失败", error);
      }
    },
  };

  const get: Tool = {
    name: "get_customer_profiles",
    effect: "read",
    description:
      "Read 1–6 profiles confirmed by search_customer_profiles, including per-product state and up to five recent observations. Multiple IDs are allowed only after explicit selection of all matching profiles for a read request. Never use for bulk updates. No contact details are returned.",
    parameters: {
      type: "object",
      properties: {
        profileIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
      },
      required: ["profileIds"],
    },
    async execute(input, context) {
      try {
        const value = object(input);
        if (!Array.isArray(value.profileIds)) throw new InputError("profileIds无效");
        const ids = value.profileIds.map((id) => parseEntityId(id, "profileId"));
        const profiles = await service.getProfilesForAgent(context.userId ?? "default", ids);
        if (profiles.length === 1) {
          await service.rememberCurrentProfile(
            context.userId ?? "default",
            context.conversationId,
            profiles[0].profile
          ).catch(() => {});
        }
        return { content: JSON.stringify(profiles) };
      } catch (error) {
        return toolError("读取客户画像失败", error);
      }
    },
  };

  const prepare: Tool = {
    name: "prepare_customer_profile_change",
    description:
      "Prepare creation or update of a customer master record. Extract every stated name/alias, organization, department, title, region, source, relationship, health and tag on the first call, not just the name. Direct contact details, archiving and manual locks to profile management. This does not write the official record. needs_confirmation requires ask_user first.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["create", "update"] },
        customerMention: { type: "string", description: "User's original name or reference for the update target." },
        displayName: { type: "string" },
        aliases: { type: "array", items: { type: "string" }, maxItems: 20 },
        organization: { type: ["string", "null"], description: "Company/organization, required when stated by the user." },
        department: { type: ["string", "null"], description: "Department, required when stated by the user." },
        title: { type: ["string", "null"], description: "Job title, such as manager, teacher or lead." },
        customerRegion: { type: ["string", "null"], description: "Customer region as free text; do not split into administrative levels." },
        source: { type: ["string", "null"], description: "Source channel, such as referral, trade show or social feed." },
        relationshipStage: { type: "string", enum: RELATIONSHIP_ENUM },
        overallHealth: { type: "string", enum: HEALTH_ENUM },
        tags: { type: "array", items: { type: "string" }, maxItems: 30, description: "Short tags grounded in the original message, such as industry, role or intent." },
      },
      required: ["operation"],
    },
    async execute(input, context) {
      try {
        const prepared = await service.prepareProfileChange(
          context.userId ?? "default",
          profileChangeInput(object(input)),
          sourceContext(context)
        );
        if (prepared.status === "ready") {
          return {
            content:
              `画像变更草稿已准备好。draftId: ${prepared.draftId}\n` +
              "Call commit_customer_profile_change immediately with draftId only; add no fields.",
          };
        }
        const mapping = prepared.candidates
          .map((candidate) => `${candidate.displayName}${candidate.customerRegion ? `（${candidate.customerRegion}）` : ""} | profileId: ${candidate.id}`)
          .join("\n");
        return {
          content:
            `画像变更User confirmation required. draftId: ${prepared.draftId}\n` +
            `Call ask_user. Translate this question into the user's language without changing its meaning: ${prepared.question ?? "Please confirm this profile change"}\n` +
            `Translate these options into the user's language, preserving order, meaning and candidate mapping: ${JSON.stringify(prepared.options ?? [])}\n` +
            (mapping ? `候选映射：\n${mapping}\n` : "") +
            "Call commit_customer_profile_change only after confirmation; do not commit on cancellation.",
        };
      } catch (error) {
        return toolError("准备画像变更失败", error);
      }
    },
  };

  const commit: Tool = {
    name: "commit_customer_profile_change",
    description:
      "Commit the server draft from prepare_customer_profile_change without additional fields. For multiple update candidates pass the selected profileId; for confirmed creation pass continueCreate=true; for confirmed critical fields pass confirm=true.",
    parameters: {
      type: "object",
      properties: {
        draftId: { type: "string" },
        profileId: { type: "string" },
        confirm: { type: "boolean" },
        continueCreate: { type: "boolean" },
      },
      required: ["draftId"],
    },
    async execute(input, context) {
      try {
        const value = object(input);
        const profile = await service.commitProfileChange(context.userId ?? "default", {
          draftId: parseDraftId(value.draftId),
          profileId: value.profileId === undefined ? undefined : parseEntityId(value.profileId, "profileId"),
          confirm: value.confirm === true,
          continueCreate: value.continueCreate === true,
        }, sourceContext(context));
        return {
          content:
            `已${profile.version === 1 ? "新建" : "更新"}「${profile.displayName}」的客户画像。\n` +
            `[查看画像](/digital-employee/profiles/${profile.id})`,
        };
      } catch (error) {
        return toolError("提交画像变更失败", error);
      }
    },
  };

  return [search, get, prepare, commit];
}

function profileChangeInput(value: Record<string, unknown>): ProfileChangeInput {
  if (value.operation !== "create" && value.operation !== "update") throw new InputError("operation无效");
  const result: ProfileChangeInput = {
    operation: value.operation,
    customerMention: optionalString(value.customerMention, 200),
    displayName: optionalString(value.displayName, 200),
    aliases: optionalStringArray(value.aliases, 20, 200),
    organization: optionalNullableString(value.organization, 200),
    department: optionalNullableString(value.department, 200),
    title: optionalNullableString(value.title, 200),
    customerRegion: optionalNullableString(value.customerRegion, 500),
    source: optionalNullableString(value.source, 64),
    relationshipStage: value.relationshipStage as RelationshipStage | undefined,
    overallHealth: value.overallHealth as Health | undefined,
    tags: optionalStringArray(value.tags, 30, 80),
  };
  return result;
}

function sourceContext(context: ToolContext) {
  return {
    conversationId: context.conversationId,
    sourceMessageId: context.sourceMessageId,
    sourceText: context.sourceText,
    modelId: context.modelId,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("参数必须是对象");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new InputError("文本字段无效");
  return value.trim();
}

function optionalNullableString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.trim().length > max) throw new InputError("文本字段无效");
  return value.trim() || null;
}

function optionalStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new InputError("数组字段无效");
  const items = value.map((item) => optionalString(item, maxLength));
  return [...new Set(items as string[])];
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new InputError("整数参数无效");
  return Number(value);
}

function toolError(prefix: string, error: unknown): ToolResult {
  return failureResult(prefix, error);
}
