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
  occurredAt?: string | null;
  facts?: Record<string, unknown>;
  proposedStatePatch?: Record<string, unknown>;
}

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
