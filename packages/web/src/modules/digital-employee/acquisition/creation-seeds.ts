import type { CampaignRecommendation, CustomerSegment, MarketingAsset, MarketingCampaignSummary } from "../types.js";
import type { CreationSeed } from "./CreationWorkspacePage.js";

/** How each marketing object fills the creation form. */
export function seedFromRecommendation(item: CampaignRecommendation): CreationSeed {
  return {
    recommendationId: item.id,
    segmentId: item.segmentId ?? undefined,
    productId: item.productId ?? undefined,
    publicAudience: item.segmentId ? undefined : item.targetSegmentDescription,
    title: item.theme,
    prompt: [item.theme, item.creativeDirection, ...item.corePoints].filter(Boolean).join("；"),
    channels: item.suggestedChannels,
    assetType: item.type === "copy" ? "copy" : item.type === "poster" ? "poster" : "video",
    durationSeconds: item.durationSeconds === 10 ? 10 : 15,
  };
}

export function seedFromAsset(item: MarketingAsset): CreationSeed {
  return {
    parentAssetId: item.id,
    campaignId: item.campaignId ?? undefined,
    title: `${item.title} · 新版本`,
    prompt: item.assetType === "text"
      ? `参考以下历史文案的主题和结构生成新版本，但不要直接照抄：\n${item.content}`
      : `基于“${item.title}”延续主题，生成一个差异化新版本。`,
    assetType: item.assetType === "video" ? "video" : item.assetType === "text" ? "copy" : "poster",
  };
}

export function seedFromCampaign(item: MarketingCampaignSummary): CreationSeed {
  return { campaignId: item.id, title: item.name, productId: item.productId ?? undefined, channels: item.channels };
}

export function seedFromSegment(item: CustomerSegment): CreationSeed {
  return { segmentId: item.id, title: `${item.name}营销内容` };
}
