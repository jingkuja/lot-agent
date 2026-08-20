import { InputError } from "./errors.js";
import {
  SEGMENT_HEALTH_VALUES,
  SEGMENT_JOURNEY_STAGES,
  SEGMENT_RELATIONSHIP_STAGES,
  type AssetListFilters,
  type CampaignListFilters,
  type CampaignResultInput,
  type CampaignUpdateInput,
  type CreateCampaignAssetInput,
  type CreateCampaignInput,
  type DeploymentInput,
  type FeedbackInput,
  type SegmentCriteria,
  type SegmentInput,
} from "./acquisition-types.js";

const ASSET_TYPES = ["copy", "poster", "video"] as const;
const STORED_ASSET_TYPES = ["text", "poster", "image", "video"] as const;
const RANGES = ["3d", "7d", "30d", "all"] as const;
const PLATFORMS = ["moments", "wechat_official", "channels", "douyin_kuaishou", "xiaohongshu", "ad_platform", "other"] as const;

export function parseSegmentInput(value: unknown): SegmentInput {
  const source = object(value);
  return {
    name: text(source.name, "客群名称", 1, 200),
    description: optionalText(source.description, "客群说明", 1_000),
    criteria: parseSegmentCriteria(source.criteria),
  };
}

export function parseAssetList(query: Record<string, string>): AssetListFilters {
  return {
    range: choice(query.range, RANGES, "range") ?? "3d",
    assetType: choice(query.assetType, STORED_ASSET_TYPES, "assetType"),
    page: integer(query.page, "page", 1, 100_000, 1),
    limit: integer(query.limit, "limit", 12, 20, 12),
  };
}

export function parseCreateCampaignAsset(value: unknown): CreateCampaignAssetInput {
  const source = object(value);
  const segmentId = optionalUuid(source.segmentId, "segmentId");
  const snapshotId = optionalUuid(source.segmentSnapshotId, "segmentSnapshotId");
  const publicAudience = optionalText(source.publicAudience, "公开受众", 500);
  const campaignId = optionalUuid(source.campaignId, "campaignId");
  if (!campaignId && !segmentId && !snapshotId && !publicAudience) throw new InputError("请选择客群、填写公开受众，或指定已有营销活动");
  const duration = source.durationSeconds === undefined ? undefined : integer(source.durationSeconds, "视频时长", 15, 60, 15);
  if (duration !== undefined && ![15, 30, 60].includes(duration)) throw new InputError("视频时长仅支持15、30或60秒");
  const productId = campaignId ? optionalUuid(source.productId, "产品") : uuid(source.productId, "产品");
  if (!campaignId && !productId) throw new InputError("产品不能为空");
  return {
    assetType: choice(source.assetType, ASSET_TYPES, "内容形式", true)!,
    prompt: text(source.prompt, "创作要求", 2, 4_000),
    segmentId,
    segmentSnapshotId: snapshotId,
    publicAudience,
    productId: productId ?? "",
    recommendationId: optionalUuid(source.recommendationId, "recommendationId"),
    parentAssetId: optionalUuid(source.parentAssetId, "parentAssetId"),
    campaignId,
    objective: campaignId ? (optionalText(source.objective, "活动目标", 500) ?? "") : text(source.objective, "活动目标", 1, 500),
    channels: stringList(source.channels, "渠道", 8, 80, !campaignId),
    callToAction: campaignId ? (optionalText(source.callToAction, "行动号召", 300) ?? "") : text(source.callToAction, "行动号召", 1, 300),
    title: optionalText(source.title, "活动名称", 300),
    durationSeconds: duration as 15 | 30 | 60 | undefined,
  };
}

export function parseDeployment(value: unknown): DeploymentInput {
  const source = object(value);
  const platform = choice(source.platform, PLATFORMS, "投放平台", true)!;
  const customPlatform = optionalText(source.customPlatform, "自定义平台", 100);
  if (platform === "other" && !customPlatform) throw new InputError("其他平台需要填写名称");
  const status = choice(source.status, ["pending", "deployed", "ended"] as const, "投放状态", true)!;
  const deployedAt = optionalDate(source.deployedAt, "投放时间");
  if (status !== "pending" && !deployedAt) throw new InputError("已投放或已结束时需要填写投放时间");
  return { platform, customPlatform, status, deployedAt };
}

export function parseFeedback(value: unknown): FeedbackInput {
  const source = object(value);
  return {
    impressions: optionalCount(source.impressions, "曝光数"),
    interactions: optionalCount(source.interactions, "互动数"),
    conversions: optionalCount(source.conversions, "转化数"),
    feedbackText: optionalText(source.feedbackText, "文字反馈", 2_000),
  };
}

export function parseRecommendationStatus(value: unknown): "adopted" | "ignored" {
  return choice(object(value).status, ["adopted", "ignored"] as const, "推荐状态", true)!;
}

export function parseRecommendationFilter(value: unknown): "pending" | "adopted" | "ignored" | "expired" | undefined {
  return choice(value, ["pending", "adopted", "ignored", "expired"] as const, "推荐状态");
}

export function parseCreateCampaign(value: unknown): CreateCampaignInput {
  const source = object(value);
  const segmentId = optionalUuid(source.segmentId, "segmentId");
  const snapshotId = optionalUuid(source.segmentSnapshotId, "segmentSnapshotId");
  const publicAudience = optionalText(source.publicAudience, "公开受众", 500);
  if (!segmentId && !snapshotId && !publicAudience) throw new InputError("请选择客群或填写明确的公开受众");
  return {
    name: text(source.name, "活动名称", 1, 300),
    objective: text(source.objective, "活动目标", 1, 500),
    channels: stringList(source.channels, "渠道", 8, 80, true),
    callToAction: text(source.callToAction, "行动号召", 1, 300),
    productId: uuid(source.productId, "产品"),
    segmentId,
    segmentSnapshotId: snapshotId,
    publicAudience,
    startsAt: optionalDate(source.startsAt, "开始时间"),
    endsAt: optionalDate(source.endsAt, "结束时间"),
    opportunityId: optionalUuid(source.opportunityId, "客群机会"),
  };
}

export function parseCampaignList(query: Record<string, string>): CampaignListFilters {
  return {
    status: choice(query.status, ["draft", "active", "completed", "archived"] as const, "status"),
    page: integer(query.page, "page", 1, 100_000, 1),
    limit: integer(query.limit, "limit", 1, 50, 20),
  };
}

export function parseCampaignUpdate(value: unknown): CampaignUpdateInput {
  const source = object(value);
  const selected = source.selectedAssets;
  let selectedAssets: CampaignUpdateInput["selectedAssets"];
  if (selected !== undefined) {
    const raw = object(selected);
    selectedAssets = {
      copy: raw.copy === null ? null : optionalUuid(raw.copy, "文案版本"),
      poster: raw.poster === null ? null : optionalUuid(raw.poster, "海报版本"),
      video: raw.video === null ? null : optionalUuid(raw.video, "视频版本"),
    };
  }
  const status = choice(source.status, ["draft", "active", "completed", "archived"] as const, "status");
  const channels = source.channels === undefined ? undefined : stringList(source.channels, "渠道", 8, 80, true);
  return {
    name: optionalText(source.name, "活动名称", 300),
    objective: optionalText(source.objective, "活动目标", 500),
    channels,
    callToAction: optionalText(source.callToAction, "行动号召", 300),
    status,
    selectedAssets,
  };
}

export function parseCampaignResult(value: unknown): CampaignResultInput {
  const source = object(value);
  return {
    campaignId: uuid(source.campaignId, "活动"),
    impressions: optionalCount(source.impressions, "曝光数"),
    interactions: optionalCount(source.interactions, "互动数"),
    conversions: optionalCount(source.conversions, "转化数"),
    leads: optionalCount(source.leads, "有效线索"),
    note: optionalText(source.note, "结果说明", 2_000),
  };
}

export function parseSegmentCriteria(value: unknown): SegmentCriteria {
  const source = object(value ?? {});
  return {
    relationshipStages: enumList(source.relationshipStages, SEGMENT_RELATIONSHIP_STAGES, "关系阶段"),
    health: enumList(source.health, SEGMENT_HEALTH_VALUES, "健康度"),
    regions: stringList(source.regions, "区域", 20, 100),
    tags: stringList(source.tags, "标签", 20, 100),
    journeyStages: enumList(source.journeyStages, SEGMENT_JOURNEY_STAGES, "产品阶段"),
    productName: optionalText(source.productName, "产品名称", 200),
    activeWithinDays: source.activeWithinDays === undefined ? undefined : integer(source.activeWithinDays, "近期活跃天数", 1, 365, 30),
    excludeAtRisk: boolean(source.excludeAtRisk, "排除风险客户"),
    excludeRecentlyContactedDays: source.excludeRecentlyContactedDays === undefined ? undefined : integer(source.excludeRecentlyContactedDays, "近期触达天数", 1, 90, 7),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("请求体格式无效");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new InputError(`${field}不能为空`);
  const result = value.trim();
  if (result.length < min || result.length > max) throw new InputError(`${field}长度应为${min}–${max}个字符`);
  return result;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, 1, max);
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field, 1, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new InputError(`${field}格式无效`);
  return result;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return uuid(value, field);
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number, required = false): string[] {
  if (value === undefined || value === null) {
    if (required) throw new InputError(`${field}不能为空`);
    return [];
  }
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > maxItems) throw new InputError(`${field}格式无效`);
  return [...new Set(value.map((item) => text(item, field, 1, maxLength)))];
}

function enumList<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  const values = stringList(value, field, allowed.length, 100);
  for (const item of values) if (!(allowed as readonly string[]).includes(item)) throw new InputError(`${field}取值无效`);
  return values as T[];
}

function choice<T extends string>(value: unknown, allowed: readonly T[], field: string, required = false): T | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InputError(`${field}不能为空`);
    return undefined;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new InputError(`${field}取值无效`);
  return value as T;
}

function integer(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new InputError(`${field}取值无效`);
  return parsed;
}

function boolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InputError(`${field}取值无效`);
  return value;
}

function optionalDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) throw new InputError(`${field}格式无效`);
  return new Date(value).toISOString();
}

function optionalCount(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) throw new InputError(`${field}取值无效`);
  return parsed;
}
