import type { Tool, ToolContext, ToolResult } from "@lot-agent/core";
import type { CustomerAcquisitionService } from "../acquisition-service.js";
import { InputError } from "../errors.js";
import { parseAssetList, parseCreateCampaignAsset, parseRecommendationFilter } from "../acquisition-validators.js";
import { parseEntityId } from "../validators.js";

const RECOMMENDATION_STATUS = ["pending", "adopted", "ignored", "expired"];

/** Conversation tools for 获客宝. They expose aggregate cohort data only;
 * paid image/video generation remains behind the structured confirmation UI. */
export function createCustomerAcquisitionTools(service: CustomerAcquisitionService): Tool[] {
  const analyze: Tool = {
    name: "analyze_customer_cohort",
    description: "读取获客宝的整体聚合群像、动态客群及最新快照指标。只返回群体统计，不返回单个客户姓名或联系方式。",
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      return run(context, "读取客群洞察失败", async (userId) => ({
        ...await service.getCohortInsights(userId),
        managementUrl: "/digital-employee/copy",
      }));
    },
  };

  const segments: Tool = {
    name: "search_customer_segments",
    description: "查询获客宝中已经保存的动态客群、筛选条件和最新聚合快照。需要生成内容时先确定唯一 segmentId 或 snapshotId。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "客群名称或说明关键词" } },
    },
    async execute(input, context) {
      return run(context, "查询客群失败", async (userId) => {
        const query = optionalString(object(input).query, 200)?.toLocaleLowerCase("zh-CN");
        const items = (await service.listSegments(userId)).filter((item) =>
          !query || `${item.name} ${item.description}`.toLocaleLowerCase("zh-CN").includes(query)
        );
        return { items: items.slice(0, 20), total: items.length, managementUrl: "/digital-employee/copy" };
      });
    },
  };

  const generateCopy: Tool = {
    name: "generate_campaign_copy",
    description:
      "根据已确认的客群快照（segmentSnapshotId）、动态客群（segmentId）或明确公开受众生成一版群体营销文案，并保存到营销资产库。" +
      "必须提供产品、目标、渠道和行动号召；不得用于单个客户联系话术。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        segmentId: { type: "string" },
        segmentSnapshotId: { type: "string" },
        publicAudience: { type: "string" },
        productId: { type: "string" },
        objective: { type: "string" },
        channels: { type: "array", items: { type: "string" }, maxItems: 8 },
        callToAction: { type: "string" },
        title: { type: "string" },
      },
      required: ["prompt", "productId", "objective", "channels", "callToAction"],
    },
    async execute(input, context) {
      return run(context, "生成群体文案失败", async (userId) => {
        const asset = await service.createAsset(userId, parseCreateCampaignAsset({ ...object(input), assetType: "copy" }));
        return {
          asset,
          message: `已生成并保存群体文案「${asset.title}」`,
          managementUrl: "/digital-employee/copy",
        };
      });
    },
  };

  const searchAssets: Tool = {
    name: "search_marketing_assets",
    description: "查询获客宝营销资产库中的文案、海报或视频及其生成、投放状态。",
    parameters: {
      type: "object",
      properties: {
        range: { type: "string", enum: ["3d", "7d", "30d", "all"] },
        assetType: { type: "string", enum: ["text", "poster", "image", "video"] },
        page: { type: "integer", minimum: 1 },
      },
    },
    async execute(input, context) {
      return run(context, "查询营销资产失败", async (userId) => {
        const value = object(input);
        const result = await service.listAssets(userId, parseAssetList({
          range: typeof value.range === "string" ? value.range : "all",
          ...(typeof value.assetType === "string" ? { assetType: value.assetType } : {}),
          page: typeof value.page === "number" ? String(value.page) : "1",
          limit: "12",
        }));
        return { ...result, managementUrl: "/digital-employee/copy" };
      });
    },
  };

  const deploymentStatus: Tool = {
    name: "get_asset_deployment_status",
    description: "读取一个已由 search_marketing_assets 确认的营销资产详情、平台投放状态和反馈。",
    parameters: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"] },
    async execute(input, context) {
      return run(context, "读取资产投放状态失败", async (userId) => {
        const asset = await service.getAsset(userId, parseEntityId(object(input).assetId, "assetId"));
        return { asset, managementUrl: "/digital-employee/copy" };
      });
    },
  };

  const refreshRecommendations: Tool = {
    name: "generate_daily_recommendations",
    description: "基于脱敏聚合群像和已确认营销资料刷新获客宝每日推荐。不会生成付费图片或视频。",
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      return run(context, "生成每日推荐失败", async (userId) => ({
        ...await service.refreshRecommendations(userId),
        managementUrl: "/digital-employee/copy",
      }));
    },
  };

  const getRecommendations: Tool = {
    name: "get_daily_recommendations",
    description: "查询获客宝每日推荐，可按待处理、已采纳、已忽略或已过期筛选。",
    parameters: { type: "object", properties: { status: { type: "string", enum: RECOMMENDATION_STATUS } } },
    async execute(input, context) {
      return run(context, "查询每日推荐失败", async (userId) => ({
        ...await service.listRecommendations(userId, parseRecommendationFilter(object(input).status)),
        managementUrl: "/digital-employee/copy",
      }));
    },
  };

  const recommendationAction = (status: "adopted" | "ignored"): Tool => ({
    name: status === "adopted" ? "adopt_recommendation" : "ignore_recommendation",
    description: status === "adopted"
      ? "把用户明确选择的待处理获客推荐标记为已采纳。"
      : "把用户明确选择的待处理获客推荐标记为已忽略。",
    parameters: { type: "object", properties: { recommendationId: { type: "string" } }, required: ["recommendationId"] },
    async execute(input, context) {
      return run(context, status === "adopted" ? "采纳推荐失败" : "忽略推荐失败", async (userId) => ({
        recommendation: await service.updateRecommendation(
          userId,
          parseEntityId(object(input).recommendationId, "recommendationId"),
          status
        ),
        managementUrl: "/digital-employee/copy",
      }));
    },
  });

  const modelConfiguration: Tool = {
    name: "check_user_generation_models",
    description: "检查当前用户是否已经配置获客宝固定使用的图片和视频模型；不展示或切换模型选择器。",
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      return run(context, "检查生成模型失败", async (userId) => service.getModelAvailability(userId));
    },
  };

  return [
    analyze,
    segments,
    generateCopy,
    searchAssets,
    deploymentStatus,
    refreshRecommendations,
    getRecommendations,
    recommendationAction("adopted"),
    recommendationAction("ignored"),
    modelConfiguration,
  ];
}

async function run(
  context: ToolContext,
  prefix: string,
  operation: (userId: string) => Promise<unknown>
): Promise<ToolResult> {
  try {
    if (context.featureScope && context.featureScope !== "customer-acquisition") {
      throw new InputError("当前对话不在获客宝作用域，请先进入获客宝对话");
    }
    return { content: JSON.stringify(await operation(context.userId ?? "default")) };
  } catch (error) {
    return {
      content: `${prefix}：${error instanceof Error ? error.message : "服务暂时不可用"}`,
      isError: true,
      errorKind: error instanceof InputError ? "validation" : "unknown",
    };
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("参数必须是对象");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new InputError("查询关键词无效");
  return value.trim();
}
