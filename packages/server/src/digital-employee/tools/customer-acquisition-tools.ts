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
    description: "Read Acquisition Hub's aggregate customer portrait, dynamic segments and latest snapshot metrics. Only group statistics; no individual names or contact details.",
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
    description: "Search saved dynamic segments, criteria and latest aggregate snapshots. Resolve a unique segmentId or snapshotId before generating content.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Segment name or description keyword." } },
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
      "Generate cohort marketing copy from a confirmed segmentSnapshotId, segmentId, explicitly public audience or existing campaign. With campaignId append to that campaign without creating another campaign/snapshot. Never use for individual outreach.",
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
    description: "Search Acquisition Hub's copy, poster and video assets and their generation/deployment status.",
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
    description: "Read an asset confirmed by search_marketing_assets, including platform deployment status and feedback.",
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
    description: "Refresh daily Acquisition Hub recommendations from anonymized aggregate portraits and confirmed marketing facts. Does not generate paid images or videos.",
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
    description: "Search daily recommendations by pending, adopted, ignored or expired status.",
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
    description: status === "adopted" ? "Mark the explicitly selected pending recommendation adopted." : "Mark the explicitly selected pending recommendation ignored.",
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
    description: "List campaigns with asset counts and outcome-entry counts. Resolve a unique campaignId before creating copy, posters or videos.",
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
    description: "Read a campaign's brief, copy/poster/video versions, selected versions and aggregate outcomes.",
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
    description: "Search cohort marketing opportunities. Acceptance creates a campaign before content generation.",
    parameters: { type: "object", properties: { status: { type: "string", enum: ["suggested", "accepted", "dismissed", "expired"] } } },
    async execute(input, context) {
      return run(context, "查询客群机会失败", async (userId) =>
        service.listCampaignOpportunities(userId, optionalString(object(input ?? {}).status, 32)));
    },
  };

  const acceptOpportunity: Tool = {
    name: "accept_campaign_opportunity",
    description: "Convert the user-selected cohort opportunity into a campaign only after explicit confirmation.",
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
    description: "Check the user's available TokenHub image/video models. If empty, direct the user to configurationUrl before generating a poster or video.",
    parameters: { type: "object", properties: {} },
    async execute(_input, context) {
      return run(context, "检查生成模型失败", async (userId) => service.getModelAvailability(userId));
    },
  };

  const prepareSegment: Tool = {
    name: "prepare_customer_segment",
    description:
      "Prepare a dynamic segment and criteria, previewing aggregate counts and exclusions without writing the official segment. After confirmation call commit_customer_segment. Only group statistics; no individual names.",
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
    description: "Commit a prepare_customer_segment draft and capture a fixed segment snapshot.",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "保存客群失败", async (userId) =>
        service.commitCustomerSegment(userId, parseDraftId(object(input).draftId)));
    },
  };

  const evaluateFit: Tool = {
    name: "evaluate_segment_product_fit",
    description:
      "Evaluate product fit, rationale and risks using anonymized group insights and confirmed product facts. Does not create a campaign or read individual customer text.",
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
      "Prepare a cohort campaign and brief. Requires a segment snapshot, dynamic segment or explicitly public audience, plus product, objective, channels and call to action. After confirmation call commit_marketing_campaign.",
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
    description: "Commit a prepare_marketing_campaign draft to create a campaign.",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "创建营销活动失败", async (userId) =>
        service.commitMarketingCampaign(userId, parseDraftId(object(input).draftId)));
    },
  };

  const mediaTool = (assetType: "poster" | "video"): Tool => ({
    name: assetType === "poster" ? "generate_campaign_poster" : "generate_campaign_video",
    description: assetType === "poster" ? "Generate a cohort poster using an available image model. First check_user_generation_models, then ask_user to confirm cost and audience." : "Generate a cohort video using an available video model. First check_user_generation_models, then ask_user to confirm cost and audience.",
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
        modelId: { type: "string", description: "User-selected generation model ID from check_user_generation_models' available list." },
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
      "Rewrite existing cohort copy, posters or videos according to the user's requirements, such as restrained tone, a particular benefit or no unconfirmed numbers. Save a new version. Do not turn it into individual outreach.",
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
    description: "Record usage only after the user explicitly states an asset was used or deployed. Generated does not mean deployed.",
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
    description: "Prepare an asset's deployment platform and status. After confirmation call commit_asset_deployment.",
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
    description: "Commit a prepare_asset_deployment draft.",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交投放记录失败", async (userId) =>
        service.commitAssetDeployment(userId, parseDraftId(object(input).draftId)));
    },
  };

  const prepareFeedback: Tool = {
    name: "prepare_deployment_feedback",
    description: "Prepare impressions, interactions, conversions or textual feedback for a deployment. After confirmation call commit_deployment_feedback.",
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
    description: "Commit a prepare_deployment_feedback draft.",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交投放反馈失败", async (userId) =>
        service.commitDeploymentFeedback(userId, parseDraftId(object(input).draftId)));
    },
  };

  const prepareResult: Tool = {
    name: "prepare_campaign_result",
    description: "Prepare aggregate campaign outcomes. Generation is not business completion. Handle identifiable inquirers through Customer Profiles and Opportunity Radar.",
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
    description: "Commit a prepare_campaign_result draft.",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    async execute(input, context) {
      return run(context, "提交活动结果失败", async (userId) =>
        service.commitCampaignResult(userId, parseDraftId(object(input).draftId)));
    },
  };

  const archiveAsset: Tool = {
    name: "archive_marketing_asset",
    description: "Archive an asset only on explicit user request. In-progress generation is cancelled.",
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
