export type RelationshipStage = "lead" | "prospect" | "customer" | "inactive" | "lost";
export type Health = "healthy" | "watch" | "at_risk";
export type JourneyStage =
  | "unknown" | "evaluating" | "trial" | "purchased" | "using" | "renewal" | "paused" | "lost" | "churned";
export type Sentiment = "positive" | "neutral" | "negative" | "mixed" | "unknown";
export type Satisfaction = "satisfied" | "neutral" | "dissatisfied" | "unknown";
export type ObservationType =
  | "contact" | "requirement" | "purchase_intent" | "trial" | "purchase"
  | "product_feedback" | "complaint" | "delivery" | "renewal" | "churn" | "note";

export interface CustomerContact {
  phone?: string;
  email?: string;
  wechat?: string;
  address?: string;
  other?: string;
}

export interface CustomerProfile {
  id: string;
  userId: string;
  ownerUserId: string;
  displayName: string;
  aliases: string[];
  customerKind: "person" | "organization_contact";
  organization: string | null;
  department: string | null;
  title: string | null;
  customerRegion: string | null;
  contact: CustomerContact | null;
  source: string | null;
  relationshipStage: RelationshipStage;
  overallHealth: Health;
  tags: string[];
  customFields: Record<string, unknown>;
  summary: string;
  summaryVersion: number;
  manualLockFields: string[];
  lastObservedAt: string | null;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  version: number;
  status: "active" | "archived";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerProductState {
  id: string;
  userId: string;
  profileId: string;
  productKey: string;
  productName: string;
  marketingProductId: string | null;
  journeyStage: JourneyStage;
  sentiment: Sentiment;
  satisfaction: Satisfaction;
  health: Health;
  needs: unknown[];
  objections: unknown[];
  currentIssues: unknown[];
  manualLockFields: string[];
  lastObservationId: string | null;
  lastConfirmedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerObservation {
  id: string;
  profileId: string;
  sourceType: string;
  sourceId: string;
  sourceLocator: Record<string, unknown>;
  rawText: string;
  occurredAt: string | null;
  createdAt: string;
}

export interface CustomerStateChange {
  id: string;
  profileId: string;
  productStateId: string | null;
  actorType: "user" | "ai_confirmed" | "system";
  beforeState: Record<string, unknown>;
  patch: Record<string, unknown>;
  afterState: Record<string, unknown>;
  reason: string | null;
  createdAt: string;
}

export interface ProfileListResponse {
  items: CustomerProfile[];
  page: number;
  limit: number;
  total: number;
}

export interface CohortCount {
  key: string;
  label: string;
  count: number;
}

export interface CustomerCohortMetrics {
  totalProfiles: number;
  activeLast7Days: number;
  dueFollowUps: number;
  relationshipStages: CohortCount[];
  health: CohortCount[];
  topTags: CohortCount[];
}

export interface DigitalEmployeeOverview {
  recentProfiles: CustomerProfile[];
  totalProfiles: number;
  cohort: {
    snapshotDate: string;
    summary: string;
    metrics: CustomerCohortMetrics;
    generatedAt: string;
    generationMethod: "llm" | "logic";
    modelId: string | null;
    source: "nightly" | "live";
  };
  schedule: {
    enabled: true;
    timeZone: "Asia/Shanghai";
    localTime: "23:00";
    nextRunAt: string;
  };
}

export interface ProfileDetailResponse {
  profile: CustomerProfile;
  productStates: CustomerProductState[];
}

export interface ProfileInput {
  displayName: string;
  aliases?: string[];
  customerKind?: CustomerProfile["customerKind"];
  organization?: string | null;
  department?: string | null;
  title?: string | null;
  customerRegion?: string | null;
  contact?: CustomerContact | null;
  source?: string | null;
  relationshipStage?: RelationshipStage;
  overallHealth?: Health;
  tags?: string[];
  customFields?: Record<string, unknown>;
  manualLockFields?: string[];
  productStates?: Array<{
    productName: string;
    productKey?: string;
    marketingProductId?: string;
    journeyStage?: JourneyStage;
    sentiment?: Sentiment;
    satisfaction?: Satisfaction;
    health?: Health;
    needs?: unknown[];
    objections?: unknown[];
    currentIssues?: unknown[];
    manualLockFields?: string[];
  }>;
}

export interface ProfileUpdateInput extends Omit<Partial<ProfileInput>, "productStates"> {
  version: number;
}

export interface ProductStateUpdateInput {
  version?: number;
  productName?: string;
  marketingProductId?: string;
  journeyStage?: JourneyStage;
  sentiment?: Sentiment;
  satisfaction?: Satisfaction;
  health?: Health;
  needs?: unknown[];
  objections?: unknown[];
  currentIssues?: unknown[];
  manualLockFields?: string[];
}

export interface ManualObservationInput {
  rawText: string;
  eventType?: ObservationType;
  productName?: string;
  marketingProductId?: string;
  occurredAt?: string | null;
  facts?: Record<string, unknown>;
  proposedStatePatch?: Record<string, unknown>;
}

export interface MarketingFact {
  statement: string;
  evidence?: string;
}

export interface MarketingObjection {
  objection: string;
  response: string;
}

export interface MarketingBenefit {
  title: string;
  description?: string;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface MarketingCaseMaterial {
  title: string;
  summary: string;
  result?: string;
  assetUrl?: string;
}

export interface MarketingVisualAsset {
  name: string;
  url: string;
  type?: string;
}

export interface MarketingProduct {
  id: string;
  userId: string;
  name: string;
  positioning: string;
  coreValues: string[];
  verifiableFacts: MarketingFact[];
  commonObjections: MarketingObjection[];
  currentBenefits: MarketingBenefit[];
  prohibitedExpressions: string[];
  caseMaterials: MarketingCaseMaterial[];
  status: "active" | "archived";
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketingBrandAssets {
  id: string;
  userId: string;
  tone: string[];
  visualAssets: MarketingVisualAsset[];
  standardCallsToAction: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type MarketingProductInput = Pick<MarketingProduct, "name"> & Partial<Pick<MarketingProduct,
  "positioning" | "coreValues" | "verifiableFacts" | "commonObjections" | "currentBenefits" | "prohibitedExpressions" | "caseMaterials"
>>;

export interface MarketingProductListResponse {
  items: MarketingProduct[];
  page: number;
  limit: number;
  total: number;
}

export type OpportunityType = "prospect_progress" | "silent_reengage" | "event_invitation" | "renewal" | "risk_recovery" |
  "new_lead_contact" | "trial_conversion" | "repurchase" | "referral";
export type StoredOpportunityType = OpportunityType | "cohort_marketing";
export type OpportunityView = "today" | "pending" | "in_progress" | "awaiting_result" | "completed";
export type OpportunityReadiness = "actionable" | "tryable" | "needs_info" | "paused";
export type OpportunityPriority = "low" | "normal" | "high";
export type TalkTrackIntent = "maintenance" | "follow_up" | "sales";
export interface TalkTrackMessage { role: "user" | "assistant"; content: string }

export interface OpportunityEvidence { fact: string; occurredAt: string; sourceType: string; sourceId?: string }
export interface OpportunityRisk { code: string; message: string; blocking: boolean }
export interface OpportunityItem {
  id: string;
  view: OpportunityView;
  opportunityId: string;
  actionId: string | null;
  actionVersion?: number;
  profileId: string;
  customerName: string;
  organization: string | null;
  relationshipStage: RelationshipStage;
  opportunityType: StoredOpportunityType;
  source: "manual" | "ai";
  title: string;
  objective: string;
  followUpMethod: string | null;
  suggestedAt: string;
  scheduledAt: string | null;
  priority: OpportunityPriority;
  reason: string;
  evidence: OpportunityEvidence[];
  readiness: OpportunityReadiness;
  riskFlags: OpportunityRisk[];
  productKey: string | null;
  productName: string | null;
  status: string;
  snoozedUntil: string | null;
  resultCriteria: string | null;
  executedAt: string | null;
  completedAt: string | null;
  closeReason: string | null;
  outcome: string | null;
  customerQuote: string | null;
  nextAction: string | null;
  overdue: boolean;
}

export interface OpportunitySettings {
  enabled: boolean;
  timezone: string;
  dailyRunTime: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  version: number;
}

export interface OpportunityListResponse {
  items: OpportunityItem[];
  total: number;
  summary: { highPriority: number; dueToday: number; overdue: number; awaitingResult: number };
  hasProfiles: boolean;
  lastDiscoveredAt: string | null;
  settings: OpportunitySettings;
}

export interface CustomerSegmentCriteria {
  relationshipStages?: RelationshipStage[];
  health?: Health[];
  regions?: string[];
  tags?: string[];
  journeyStages?: JourneyStage[];
  productName?: string;
  activeWithinDays?: number;
  excludeAtRisk?: boolean;
  excludeRecentlyContactedDays?: number;
}

export interface CustomerSegmentMetrics {
  totalProfiles: number;
  excludedProfiles: number;
  relationshipStages: Array<{ key: string; label?: string; count: number }>;
  health: Array<{ key: string; label?: string; count: number }>;
  regions: Array<{ key: string; label?: string; count: number }>;
  journeyStages: Array<{ key: string; label?: string; count: number }>;
  commonNeeds: Array<{ key?: string; label: string; count: number }>;
  commonObjections: Array<{ key?: string; label: string; count: number }>;
  topTags: Array<{ key?: string; label: string; count: number }>;
  warnings: string[];
}

export interface CustomerSegmentSnapshot {
  id: string;
  segmentId: string | null;
  audienceDescription: string;
  criteria: CustomerSegmentCriteria;
  profileIds: string[];
  excludedProfileIds: string[];
  metrics: CustomerSegmentMetrics;
  sampledAt: string;
  createdAt: string;
  memberPreview?: Array<{ id: string; displayName: string; relationshipStage: RelationshipStage; health: Health; region: string | null }>;
}

export interface CustomerSegment {
  id: string;
  name: string;
  description: string;
  criteria: CustomerSegmentCriteria;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  latestSnapshot?: Pick<CustomerSegmentSnapshot, "id" | "metrics" | "sampledAt">;
}

export interface AcquisitionInsights {
  overall: { snapshotDate: string; summary: string; metrics: CustomerCohortMetrics; generatedAt: string; generationMethod: string; modelId: string | null } | null;
  segments: CustomerSegment[];
}

export type CampaignRecommendationType = "copy" | "poster" | "video_script";
export interface CampaignRecommendation {
  id: string;
  type: CampaignRecommendationType;
  segmentId: string | null;
  segmentName: string | null;
  productId: string | null;
  productName: string | null;
  targetSegmentDescription: string;
  theme: string;
  corePoints: string[];
  suggestedChannels: string[];
  reasoning: string[];
  creativeDirection: string;
  durationSeconds: number | null;
  status: "pending" | "adopted" | "ignored" | "expired";
  generatedAt: string;
  expiresAt: string;
}

export interface AcquisitionModelOption {
  id: string;
  label?: string;
}

export interface AcquisitionModelConfiguration {
  llm: boolean;
  image: boolean;
  video: boolean;
  llmModelId: string | null;
  imageModelId: string | null;
  videoModelId: string | null;
  llmModels: AcquisitionModelOption[];
  imageModels: AcquisitionModelOption[];
  videoModels: AcquisitionModelOption[];
  configurationUrl: string;
}

export type MarketingAssetType = "text" | "poster" | "image" | "video";
export type DeploymentPlatform = "moments" | "wechat_official" | "channels" | "douyin_kuaishou" | "xiaohongshu" | "ad_platform" | "other";
export interface DeploymentFeedback {
  id: string;
  deploymentId?: string;
  impressions: number | null;
  interactions: number | null;
  conversions: number | null;
  feedbackText: string;
  recordedAt: string;
}
export interface AssetDeployment {
  id: string;
  assetId?: string;
  platform: DeploymentPlatform;
  customPlatform: string | null;
  status: "pending" | "deployed" | "ended";
  deployedAt: string | null;
  feedback: DeploymentFeedback[];
}
export interface MarketingAsset {
  id: string;
  campaignId: string | null;
  campaignName: string | null;
  segmentSnapshotId: string | null;
  segmentName: string | null;
  parentAssetId: string | null;
  assetType: MarketingAssetType;
  title: string;
  content: string;
  fileUrl: string | null;
  source: "workspace" | "recommendation" | "reuse";
  modelId: string | null;
  taskId: string | null;
  generationStatus: "pending" | "running" | "ready" | "failed" | "cancelled";
  status: "draft" | "ready" | "archived";
  version: number;
  deployments: AssetDeployment[];
  createdAt: string;
  updatedAt: string;
}
export interface MarketingAssetListResponse {
  items: MarketingAsset[];
  total: number;
  page: number;
  limit: number;
}

export interface CampaignSelectedAssets {
  copy: string | null;
  poster: string | null;
  video: string | null;
}

export interface MarketingCampaignSummary {
  id: string;
  name: string;
  objective: string;
  channels: string[];
  callToAction: string;
  status: "draft" | "active" | "completed" | "archived";
  productId: string | null;
  productName: string | null;
  segmentSnapshotId: string | null;
  audienceDescription: string;
  opportunityId: string | null;
  selectedAssets: CampaignSelectedAssets;
  assetCount: number;
  resultCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarketingCampaignDetail extends MarketingCampaignSummary {
  brief: Record<string, unknown> | null;
  assets: { copy: MarketingAsset[]; poster: MarketingAsset[]; video: MarketingAsset[] };
  results: {
    impressions: number;
    interactions: number;
    conversions: number;
    leads: number;
    items: Array<{ id: string; impressions: number | null; interactions: number | null; conversions: number | null; leads: number | null; note: string; recordedAt: string }>;
  };
}

export interface CampaignOpportunity {
  id: string;
  title: string;
  objective: string;
  theme: string;
  reasoning: string;
  corePoints: string[];
  suggestedChannels: string[];
  risks: string[];
  priority: "low" | "normal" | "high";
  status: "suggested" | "accepted" | "dismissed" | "expired";
  productId: string | null;
  productName: string | null;
  segmentSnapshotId: string;
  audienceDescription: string;
  campaignId: string | null;
  createdAt: string;
}

export interface AcquisitionAnalytics {
  assets: { total: number; text: number; image: number; video: number; deployed: number };
  totals: { deployments: number; feedbackCount: number; impressions: number; interactions: number; conversions: number };
  platforms: Array<{ platform: DeploymentPlatform; customPlatform: string | null; deployments: number; impressions: number; interactions: number; conversions: number }>;
}

export const OPPORTUNITY_TYPE_LABELS: Record<StoredOpportunityType, string> = {
  prospect_progress: "潜客推进", silent_reengage: "沉默唤醒", event_invitation: "活动邀约", renewal: "续费经营",
  risk_recovery: "风险挽回", new_lead_contact: "新线索首触达", trial_conversion: "试用转化", repurchase: "复购增购",
  referral: "转介绍", cohort_marketing: "客群营销（历史）",
};
export const READINESS_LABELS: Record<OpportunityReadiness, string> = {
  actionable: "可行动", tryable: "可尝试", needs_info: "需补信息", paused: "暂停营销",
};
export const OUTCOME_LABELS: Record<string, string> = {
  no_response: "无响应", replied: "已回复", interested: "感兴趣 / 有效下一步", scheduled: "已预约",
  won: "已成交或续费", rejected: "拒绝", service_needed: "投诉或需要服务处理",
};

export const RELATIONSHIP_LABELS: Record<RelationshipStage, string> = {
  lead: "线索",
  prospect: "潜客",
  customer: "客户",
  inactive: "暂无活跃关系",
  lost: "已流失",
};

export const HEALTH_LABELS: Record<Health, string> = {
  healthy: "健康",
  watch: "需关注",
  at_risk: "有风险",
};

export const JOURNEY_LABELS: Record<JourneyStage, string> = {
  unknown: "未知",
  evaluating: "评估中",
  trial: "试用中",
  purchased: "已购买",
  using: "使用中",
  renewal: "续费阶段",
  paused: "已暂停",
  lost: "已放弃",
  churned: "已流失",
};

export const SATISFACTION_LABELS: Record<Satisfaction, string> = {
  satisfied: "满意",
  neutral: "一般",
  dissatisfied: "不满意",
  unknown: "未知",
};

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
  positive: "积极",
  neutral: "中性",
  negative: "消极",
  mixed: "复杂",
  unknown: "未知",
};

export const OBSERVATION_LABELS: Record<ObservationType, string> = {
  contact: "一般联系",
  requirement: "需求",
  purchase_intent: "购买意向",
  trial: "试用",
  purchase: "成交/购买",
  product_feedback: "产品反馈",
  complaint: "投诉",
  delivery: "交付",
  renewal: "续费",
  churn: "流失/放弃",
  note: "其他备注",
};
