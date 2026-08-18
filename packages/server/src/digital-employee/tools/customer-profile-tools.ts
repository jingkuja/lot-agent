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
    description:
      "查询或统计当前账号的客户画像。支持名称/别名关键词、总体关系、健康度和标签筛选。" +
      "返回的 total 是数据库匹配总数，items 只是当前页；回答数量问题必须使用 total。此工具不返回联系方式。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "客户姓名、称呼或别名关键词" },
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
    description:
      "读取1到6条已经由 search_customer_profiles 确认的画像详情、分产品状态和最多5条近期观察。" +
      "多匹配只读请求可在用户明确选择“全部匹配画像”后传入多个候选 ID；不得用于批量更新，也不返回联系方式。",
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
      "准备对话式新建或更新客户主档。只处理姓名、别名、客户区域、来源、总体关系、健康度和标签；" +
      "联系方式、归档、人工锁定请引导至“客户画像管理”。此工具不写正式画像，返回 needs_confirmation 时必须先调用 ask_user。",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["create", "update"] },
        customerMention: { type: "string", description: "更新目标在用户原话中的称呼" },
        displayName: { type: "string" },
        aliases: { type: "array", items: { type: "string" }, maxItems: 20 },
        customerRegion: { type: ["string", "null"], description: "客户区域，自由文本，不拆分省市区" },
        source: { type: ["string", "null"] },
        relationshipStage: { type: "string", enum: RELATIONSHIP_ENUM },
        overallHealth: { type: "string", enum: HEALTH_ENUM },
        tags: { type: "array", items: { type: "string" }, maxItems: 30 },
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
              "现在立即调用 commit_customer_profile_change，只传 draftId；不要追加字段。",
          };
        }
        const mapping = prepared.candidates
          .map((candidate) => `${candidate.displayName}${candidate.customerRegion ? `（${candidate.customerRegion}）` : ""} | profileId: ${candidate.id}`)
          .join("\n");
        return {
          content:
            `画像变更需要用户确认。draftId: ${prepared.draftId}\n` +
            `请调用 ask_user，question 必须为：${prepared.question ?? "请确认本次画像变更"}\n` +
            `options 必须为：${JSON.stringify(prepared.options ?? [])}\n` +
            (mapping ? `候选映射：\n${mapping}\n` : "") +
            "确认后再调用 commit_customer_profile_change；取消时不要提交。",
        };
      } catch (error) {
        return toolError("准备画像变更失败", error);
      }
    },
  };

  const commit: Tool = {
    name: "commit_customer_profile_change",
    description:
      "提交 prepare_customer_profile_change 产生的服务端草稿。不得附加新字段。" +
      "多候选更新传用户选择对应的 profileId；继续新建传 continueCreate=true；关键字段经用户确认后传 confirm=true。",
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
  return {
    content: `${prefix}：${error instanceof Error ? error.message : "服务暂时不可用"}`,
    isError: true,
    errorKind: error instanceof InputError ? "validation" : "unknown",
  };
}
