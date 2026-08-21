export const DEFAULT_TOKENHUB_CONFIGURATION_URL = "https://wetok.ai/";

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

export interface CampaignAssetAttachment {
  assetId: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  kind: "image" | "doc";
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
    knowledgeBaseIds?: string[];
    attachments?: CampaignAssetAttachment[];
  }): Promise<{ title: string; content: string; modelId: string }>;
  evaluateFit?(input: {
    userId: string;
    audience: Record<string, unknown>;
    product: Record<string, unknown>;
    brand: Record<string, unknown> | null;
  }): Promise<CampaignFitDraft & { modelId: string }>;
}

export interface CampaignModelOption {
  id: string;
  label?: string;
}

export interface CampaignModelAvailability {
  image: boolean;
  video: boolean;
  imageModelId: string | null;
  videoModelId: string | null;
  imageModels: CampaignModelOption[];
  videoModels: CampaignModelOption[];
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

export interface CampaignMediaSettings {
  size?: string;
  n?: number;
  quality?: string;
  durationSec?: number;
  ratio?: string;
}

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
  durationSeconds?: number;
  modelId?: string;
  knowledgeBaseIds?: string[];
  attachments?: CampaignAssetAttachment[];
  mediaSettings?: CampaignMediaSettings;
  input_reference?: string | string[];
  reference_video?: string | string[];
  reference_audio?: string | string[];
  first_frame?: string;
  last_frame?: string;
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

export interface CreateCampaignInput {
  name: string;
  objective: string;
  channels: string[];
  callToAction: string;
  productId: string;
  segmentId?: string;
  segmentSnapshotId?: string;
  publicAudience?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  opportunityId?: string;
}

export interface CampaignListFilters {
  status?: "draft" | "active" | "completed" | "archived";
  page: number;
  limit: number;
}

export interface CampaignUpdateInput {
  name?: string;
  objective?: string;
  channels?: string[];
  callToAction?: string;
  status?: "draft" | "active" | "completed" | "archived";
  selectedAssets?: Partial<Record<"copy" | "poster" | "video", string | null>>;
}

export interface CampaignFitDraft {
  title: string;
  objective: string;
  theme: string;
  reasoning: string[];
  corePoints: string[];
  suggestedChannels: string[];
  risks: string[];
  priority: "low" | "normal" | "high";
}

export interface AcquisitionLeadInput {
  displayName: string;
  organization?: string | null;
  sourceCampaign?: string;
  productName?: string;
  quote?: string;
}

export interface CampaignResultInput {
  campaignId: string;
  impressions?: number | null;
  interactions?: number | null;
  conversions?: number | null;
  leads?: number | null;
  note?: string;
}
