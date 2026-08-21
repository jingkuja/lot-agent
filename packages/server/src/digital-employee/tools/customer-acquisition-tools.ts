import type { Tool, ToolContext, ToolResult } from "@lot-agent/core";
import type { CustomerAcquisitionService } from "../acquisition-service.js";
import { InputError } from "../errors.js";
import {
  parseAssetList, parseCampaignResult, parseCreateCampaign, parseCreateCampaignAsset, parseDeployment, parseFeedback,
  parseRecommendationFilter, parseSegmentInput,
} from "../acquisition-validators.js";
import { parseDraftId, parseEntityId } from "../validators.js";
import { confirmationContent, sourceContext } from "./agent-tool-helpers.js";

const RECOMMENDATION_STATUS = ["pending", "adopted", "ignored", "expired"];

/** Conversation tools for 获客宝. Aggregate cohort data only; paid media still
 * requires model checks and explicit user confirmation before generate_* calls. */
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
      "根据已确认的客群快照（segmentSnapshotId）、动态客群（segmentId）、明确公开受众或已有营销活动生成一版群体营销文案。" +
      "已有 campaignId 时追加到该活动，不会再新建活动和快照。不得用于单个客户联系话术。",
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
        campaignId: { type: "string" },
        recommendationId: { type: "string" },
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

  const searchCampaigns: Tool = {
    name: "search_marketing_campaigns",
    description: "查询获客宝营销活动列表，含素材数量和结果回填次数。生成文案/海报/视频前应先确定唯一 campaignId。",
    parameters: {
      type: "object",
      properties: { status: { type: "string", enum: ["draft", "active", "completed", "archived"] } },
    },
    async execute(input, context) {
      return run(context, "查询营销活动失败", async (userId) => ({
        ...await service.listCampaigns(userId, { status: object(input ?? {}).status as "draft" | undefined, page: 1, limit: 20 }),
        managementUrl: "/digital-employee/copy",
      }));
    },
  };

  const getCampaign: Tool = {
    name: "get_marketing_campaign",
    description: "读取一个营销活动的简报、文案/海报/视频版本、选用版本和群体结果汇总。",
    parameters: { type: "object", properties: { campaignId: { type: "string" } }, required: ["campaignId"] },
    async execute(input, context) {
      return run(context, "读取营销活动失败", async (userId) => ({
        campaign: await service.getCampaign(userId, parseEntityId(object(input).campaignId, "campaignId")),
        managementUrl: "/digital-employee/copy",
      }));
    },
  };

  const searchOpportunities: Tool = {
    name: "search_campaign_opportunities",
    description: "查询获客宝客群营销机会。采纳后会创建营销活动，再生成内容。",
    parameters: { type: "object", properties: { status: { type: "string", enum: ["suggested", "accepted", "dismissed", "expired"] } } },
    async execute(input, context) {
      return run(context, "查询客群机会失败", async (userId) =>
        service.listCampaignOpportunities(userId, optionalString(object(input ?? {}).status, 32)));
    },
  };

  const acceptOpportunity: Tool = {
    name: "accept_campaign_opportunity",
    description: "把用户明确选择的客群营销机会转成营销活动。只在用户确认后调用。",
    parameters: { type: "object", properties: { opportunityId: { type: "string" } }, required: ["opportunityId"] },
    async execute(input, context) {
      return run(context, "采纳客群机会失败", async (userId) => ({
        campaign: await service.acceptCampaignOpportunity(userId, parseEntityId(object(input).opportunityId, "opportunityId")),
        managementUrl: "/digital-employee/copy",
      }));
    },
  };

  const modelConfiguration: Tool = {
    name: "check_user_generation_models",
    description: "检查当前用户在 TokenHub 已开通的图像和视频模型列表。若列表为空，引导用户前往 configurationUrl 配置后再生成海报或视频。",
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      return run(context, "检查生成模型失败", async (userId) => service.getModelAvailability(userId));
    },
  };

  const prepareSegment: Tool = {
    name: "prepare_customer_segment",
    description:
      "准备保存一个动态客群及其筛选条件，并预览聚合人数与排除项。不直接写正式客群。" +
      "确认后调用 commit_customer_segment。只返回群体统计，不返回单个客户姓名。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        criteria: {
          type: "object",
          properties: {
            relationshipStages: { type: "array", items: { type: "string" } },
            health: { type: "array", items: { type: "string" } },
            regions: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            journeyStages: { type: "array", items: { type: "string" } },
            productName: { type: "string" },
            activeWithinDays: { type: "integer" },
            excludeAtRisk: { type: "boolean" },
            excludeRecentlyContactedDays: { type: "integer" },
          },
        },
      },
      required: ["name", "criteria"],
    },
    async execute(input, context) {
      return run(context, "准备客群失败", async (userId) => {
        const draft = await service.prepareCustomerSegment(userId, parseSegmentInput(input), sourceContext(context));
        return confirmationContent(draft, "commit_customer_segment");
      });
    },
  };

  const commitSegment: Tool = {
    name: "commit_customer_segment",
    description: "提交 prepare_customer_segment 产生的草稿并固定一次客群快照。",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "保存客群失败", async (userId) =>
        service.commitCustomerSegment(userId, parseDraftId(object(input).draftId)));
    },
  };

  const evaluateFit: Tool = {
    name: "evaluate_segment_product_fit",
    description:
      "结合脱敏聚合群像和已确认产品资料，判断该类客户适合推什么、为什么、风险是什么。" +
      "不创建营销活动，也不读取单个客户原文。",
    parameters: {
      type: "object",
      properties: {
        segmentId: { type: "string" },
        segmentSnapshotId: { type: "string" },
        productId: { type: "string" },
      },
      required: ["productId"],
    },
    async execute(input, context) {
      return run(context, "评估客群产品匹配失败", async (userId) => {
        const value = object(input);
        return service.evaluateSegmentProductFit(userId, {
          productId: parseEntityId(value.productId, "productId"),
          segmentId: value.segmentId === undefined ? undefined : parseEntityId(value.segmentId, "segmentId"),
          segmentSnapshotId: value.segmentSnapshotId === undefined ? undefined : parseEntityId(value.segmentSnapshotId, "segmentSnapshotId"),
        });
      });
    },
  };

  const prepareCampaign: Tool = {
    name: "prepare_marketing_campaign",
    description:
      "准备创建一次客群营销活动及简报。必须有客群快照、动态客群或明确公开受众，以及产品、目标、渠道和行动号召。" +
      "确认后调用 commit_marketing_campaign。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        objective: { type: "string" },
        channels: { type: "array", items: { type: "string" }, maxItems: 8 },
        callToAction: { type: "string" },
        productId: { type: "string" },
        segmentId: { type: "string" },
        segmentSnapshotId: { type: "string" },
        publicAudience: { type: "string" },
        startsAt: { type: "string" },
        endsAt: { type: "string" },
      },
      required: ["name", "objective", "channels", "callToAction", "productId"],
    },
    async execute(input, context) {
      return run(context, "准备营销活动失败", async (userId) => {
        const draft = await service.prepareMarketingCampaign(userId, parseCreateCampaign(input), sourceContext(context));
        return confirmationContent(draft, "commit_marketing_campaign");
      });
    },
  };

  const commitCampaign: Tool = {
    name: "commit_marketing_campaign",
    description: "提交 prepare_marketing_campaign 产生的草稿，创建营销活动。",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "创建营销活动失败", async (userId) =>
        service.commitMarketingCampaign(userId, parseDraftId(object(input).draftId)));
    },
  };

  const mediaTool = (assetType: "poster" | "video"): Tool => ({
    name: assetType === "poster" ? "generate_campaign_poster" : "generate_campaign_video",
    description: assetType === "poster"
      ? "在用户确认费用和受众后生成客群营销海报。使用用户选择或当前可用的图像模型。必须先 check_user_generation_models，并用 ask_user 确认后再调用。"
      : "在用户确认费用和受众后生成客群营销视频。使用用户选择或当前可用的视频模型。必须先 check_user_generation_models，并用 ask_user 确认后再调用。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        segmentId: { type: "string" },
        segmentSnapshotId: { type: "string" },
        publicAudience: { type: "string" },
        productId: { type: "string" },
        campaignId: { type: "string" },
        objective: { type: "string" },
        channels: { type: "array", items: { type: "string" }, maxItems: 8 },
        callToAction: { type: "string" },
        title: { type: "string" },
        recommendationId: { type: "string" },
        durationSeconds: { type: "integer", enum: [15, 30, 60] },
        modelId: { type: "string", description: "用户选择的生成模型 id，必须来自 check_user_generation_models 返回的可用列表。" },
      },
      required: ["prompt", "productId", "objective", "channels", "callToAction"],
    },
    async execute(input, context) {
      return run(context, assetType === "poster" ? "生成海报失败" : "生成视频失败", async (userId) => {
        const asset = await service.createAsset(userId, parseCreateCampaignAsset({ ...object(input), assetType }));
        return {
          asset,
          message: assetType === "poster" ? "已提交海报生成任务，完成后会进入营销资产库。" : "已提交视频生成任务，完成后会进入营销资产库。",
          managementUrl: "/digital-employee/copy",
        };
      });
    },
  });

  const rewriteAsset: Tool = {
    name: "rewrite_campaign_asset",
    description:
      "按用户要求改写已生成的群体文案、海报或视频，例如更克制、强调某一卖点、不能出现未确认数字。保存为新版本。不得改成单客户话术。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        instruction: { type: "string" },
      },
      required: ["assetId", "instruction"],
    },
    async execute(input, context) {
      return run(context, "改写营销资产失败", async (userId) => {
        const value = object(input);
        const asset = await service.rewriteAsset(
          userId,
          parseEntityId(value.assetId, "assetId"),
          asObjectString(value.instruction, "改写要求")
        );
        return { asset, managementUrl: "/digital-employee/copy" };
      });
    },
  };

  const recordUsage: Tool = {
    name: "record_campaign_usage",
    description: "在用户明确表示已使用或已投放某项营销资产后记录使用。生成完成不等于已投放。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        platform: { type: "string", enum: ["moments", "wechat_official", "channels", "douyin_kuaishou", "xiaohongshu", "ad_platform", "other"] },
        customPlatform: { type: "string" },
        status: { type: "string", enum: ["pending", "deployed", "ended"] },
        deployedAt: { type: "string" },
      },
      required: ["assetId", "platform", "status"],
    },
    async execute(input, context) {
      return run(context, "记录资产使用失败", async (userId) => {
        const value = object(input);
        const deployment = await service.recordCampaignUsage(
          userId,
          parseEntityId(value.assetId, "assetId"),
          parseDeployment(value)
        );
        return { deployment, managementUrl: "/digital-employee/copy" };
      });
    },
  };

  const prepareDeployment: Tool = {
    name: "prepare_asset_deployment",
    description: "准备标记营销资产的投放状态和平台。确认后调用 commit_asset_deployment。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        platform: { type: "string", enum: ["moments", "wechat_official", "channels", "douyin_kuaishou", "xiaohongshu", "ad_platform", "other"] },
        customPlatform: { type: "string" },
        status: { type: "string", enum: ["pending", "deployed", "ended"] },
        deployedAt: { type: "string" },
      },
      required: ["assetId", "platform", "status"],
    },
    async execute(input, context) {
      return run(context, "准备投放记录失败", async (userId) => {
        const value = object(input);
        const draft = await service.prepareAssetDeployment(
          userId,
          parseEntityId(value.assetId, "assetId"),
          parseDeployment(value),
          sourceContext(context)
        );
        return confirmationContent(draft, "commit_asset_deployment");
      });
    },
  };

  const commitDeployment: Tool = {
    name: "commit_asset_deployment",
    description: "提交 prepare_asset_deployment 产生的草稿。",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交投放记录失败", async (userId) =>
        service.commitAssetDeployment(userId, parseDraftId(object(input).draftId)));
    },
  };

  const prepareFeedback: Tool = {
    name: "prepare_deployment_feedback",
    description: "准备记录某次投放的曝光、互动、转化或文字反馈。确认后调用 commit_deployment_feedback。",
    parameters: {
      type: "object",
      properties: {
        deploymentId: { type: "string" },
        impressions: { type: "integer" },
        interactions: { type: "integer" },
        conversions: { type: "integer" },
        feedbackText: { type: "string" },
      },
      required: ["deploymentId"],
    },
    async execute(input, context) {
      return run(context, "准备投放反馈失败", async (userId) => {
        const value = object(input);
        const draft = await service.prepareDeploymentFeedback(
          userId,
          parseEntityId(value.deploymentId, "deploymentId"),
          parseFeedback(value),
          sourceContext(context)
        );
        return confirmationContent(draft, "commit_deployment_feedback");
      });
    },
  };

  const commitFeedback: Tool = {
    name: "commit_deployment_feedback",
    description: "提交 prepare_deployment_feedback 产生的草稿。",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交投放反馈失败", async (userId) =>
        service.commitDeploymentFeedback(userId, parseDraftId(object(input).draftId)));
    },
  };

  const prepareResult: Tool = {
    name: "prepare_campaign_result",
    description: "准备回填一次营销活动的群体结果。不把生成完成当作业务完成。具体咨询者应转到客户画像和商机参谋。",
    parameters: {
      type: "object",
      properties: {
        campaignId: { type: "string" },
        impressions: { type: "integer" },
        interactions: { type: "integer" },
        conversions: { type: "integer" },
        leads: { type: "integer" },
        note: { type: "string" },
      },
      required: ["campaignId"],
    },
    async execute(input, context) {
      return run(context, "准备活动结果失败", async (userId) => {
        const draft = await service.prepareCampaignResult(userId, parseCampaignResult(input), sourceContext(context));
        return confirmationContent(draft, "commit_campaign_result");
      });
    },
  };

  const commitResult: Tool = {
    name: "commit_campaign_result",
    description: "提交 prepare_campaign_result 产生的草稿。",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交活动结果失败", async (userId) =>
        service.commitCampaignResult(userId, parseDraftId(object(input).draftId)));
    },
  };

  const archiveAsset: Tool = {
    name: "archive_marketing_asset",
    description: "在用户明确要求后归档一项营销资产。进行中的生成任务会被取消。",
    parameters: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"] },
    async execute(input, context) {
      return run(context, "归档营销资产失败", async (userId) =>
        service.archiveAsset(userId, parseEntityId(object(input).assetId, "assetId")));
    },
  };

  return [
    analyze,
    segments,
    prepareSegment,
    commitSegment,
    evaluateFit,
    prepareCampaign,
    commitCampaign,
    searchCampaigns,
    getCampaign,
    searchOpportunities,
    acceptOpportunity,
    generateCopy,
    mediaTool("poster"),
    mediaTool("video"),
    rewriteAsset,
    searchAssets,
    deploymentStatus,
    recordUsage,
    prepareDeployment,
    commitDeployment,
    prepareFeedback,
    commitFeedback,
    prepareResult,
    commitResult,
    archiveAsset,
    refreshRecommendations,
    getRecommendations,
    recommendationAction("adopted"),
    recommendationAction("ignored"),
    modelConfiguration,
  ];
}

function asObjectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${label}不能为空`);
  if (value.trim().length > 4_000) throw new InputError(`${label}过长`);
  return value.trim();
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
    const value = await operation(context.userId ?? "default");
    return { content: typeof value === "string" ? value : JSON.stringify(value) };
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
