export const CAMPAIGN_IMAGE_MODEL = "gpt-image-2.0" as const;
export const CAMPAIGN_VIDEO_MODEL = "seedance 2.0" as const;

export const SEGMENT_RELATIONSHIP_STAGES = ["lead", "prospect", "customer", "inactive", "lost"] as const;
export const SEGMENT_HEALTH_VALUES = ["healthy", "watch", "at_risk"] as const;
export const SEGMENT_JOURNEY_STAGES = ["unknown", "evaluating", "trial", "purchased", "using", "renewal", "paused", "lost", "churned"] as const;

export interface SegmentCriteria {
  relationshipStages?: string[];
  health?: string[];
  regions?: string[];
  tags?: string[];
  journeyStages?: string[];
  productName?: string;
  activeWithinDays?: number;
  excludeAtRisk?: boolean;
  excludeRecentlyContactedDays?: number;
}

export interface SegmentInput {
  name: string;
  description?: string;
  criteria: SegmentCriteria;
}

export interface SegmentMetrics {
  totalProfiles: number;
  excludedProfiles: number;
  relationshipStages: Array<{ key: string; count: number }>;
  health: Array<{ key: string; count: number }>;
  regions: Array<{ key: string; count: number }>;
  journeyStages: Array<{ key: string; count: number }>;
  commonNeeds: Array<{ label: string; count: number }>;
  commonObjections: Array<{ label: string; count: number }>;
  topTags: Array<{ label: string; count: number }>;
  warnings: string[];
}

export interface CampaignRecommendationDraft {
  type: "copy" | "poster" | "video_script";
  segmentId?: string | null;
  productId?: string | null;
  targetSegmentDescription: string;
  theme: string;
  corePoints: string[];
  suggestedChannels: string[];
  reasoning: string[];
  creativeDirection?: string;
  durationSeconds?: number | null;
}

export interface CampaignContentGenerator {
  recommend(input: {
    userId: string;
    cohort: Record<string, unknown>;
    segments: Array<Record<string, unknown>>;
    products: Array<Record<string, unknown>>;
    brand: Record<string, unknown> | null;
  }): Promise<{ recommendations: CampaignRecommendationDraft[]; modelId: string }>;
  createCopy(input: {
    userId: string;
    prompt: string;
    brief: Record<string, unknown>;
  }): Promise<{ title: string; content: string; modelId: string }>;
}

export interface CampaignModelAvailability {
  image: boolean;
  video: boolean;
  imageModelId: string | null;
  videoModelId: string | null;
  configurationUrl: string;
}

export interface CampaignModelResolver {
  get(userId: string): Promise<CampaignModelAvailability>;
  checkQuota?(input: {
    userId: string;
    mediaType: "image" | "video";
    modelId: string;
    outputCount: number;
  }): Promise<{ ok: boolean; reason?: string }>;
}

export type AssetTypeInput = "copy" | "poster" | "video";

export interface CreateCampaignAssetInput {
  assetType: AssetTypeInput;
  prompt: string;
  segmentId?: string;
  segmentSnapshotId?: string;
  publicAudience?: string;
  productId: string;
  recommendationId?: string;
  parentAssetId?: string;
  campaignId?: string;
  objective: string;
  channels: string[];
  callToAction: string;
  title?: string;
  durationSeconds?: 15 | 30 | 60;
}

export interface AssetListFilters {
  range: "3d" | "7d" | "30d" | "all";
  assetType?: "text" | "poster" | "image" | "video";
  page: number;
  limit: number;
}

export interface DeploymentInput {
  platform: "moments" | "wechat_official" | "channels" | "douyin_kuaishou" | "xiaohongshu" | "ad_platform" | "other";
  customPlatform?: string;
  status: "pending" | "deployed" | "ended";
  deployedAt?: string | null;
}

export interface FeedbackInput {
  impressions?: number | null;
  interactions?: number | null;
  conversions?: number | null;
  feedbackText?: string;
}
