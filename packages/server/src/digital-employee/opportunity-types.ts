export const OPPORTUNITY_TYPES = [
  "prospect_progress", "silent_reengage", "event_invitation", "renewal", "risk_recovery",
  "new_lead_contact", "trial_conversion", "repurchase", "referral",
] as const;
export type OpportunityType = typeof OPPORTUNITY_TYPES[number];
/** Kept only so already-created rows remain readable after cohort marketing
 * moves to Acquisition Hub. New advisor inputs must use OpportunityType. */
export type StoredOpportunityType = OpportunityType | "cohort_marketing";

export const READINESS_VALUES = ["actionable", "tryable", "needs_info", "paused"] as const;
export type OpportunityReadiness = typeof READINESS_VALUES[number];
export const PRIORITY_VALUES = ["low", "normal", "high"] as const;
export type OpportunityPriority = typeof PRIORITY_VALUES[number];
export const OPPORTUNITY_VIEWS = ["today", "pending", "in_progress", "awaiting_result", "completed"] as const;
export type OpportunityView = typeof OPPORTUNITY_VIEWS[number];

export interface OpportunityEvidence {
  fact: string;
  occurredAt: string;
  sourceType: string;
  sourceId?: string;
}

export interface OpportunityRisk {
  code: string;
  message: string;
  blocking: boolean;
}

export interface OpportunityListItem {
  id: string;
  view: OpportunityView;
  opportunityId: string;
  actionId: string | null;
  profileId: string;
  customerName: string;
  organization: string | null;
  relationshipStage: string;
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
  actionVersion?: number;
}

export interface OpportunityListFilters {
  view: OpportunityView;
  readiness?: OpportunityReadiness;
  priority?: OpportunityPriority;
  opportunityType?: OpportunityType;
  relationshipStage?: string;
  product?: string;
  suggestedFrom?: string;
  suggestedTo?: string;
  query?: string;
  profileId?: string;
}

export interface OpportunitySummary {
  highPriority: number;
  dueToday: number;
  overdue: number;
  awaitingResult: number;
}

export interface OpportunitySettings {
  enabled: boolean;
  timezone: string;
  dailyRunTime: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  version: number;
}

export interface OpportunityDecisionInput {
  decision: "accept" | "snooze" | "dismiss";
  reason?: string;
  snoozedUntil?: string;
  scheduledAt?: string;
  followUpMethod?: string;
  objective?: string;
  resultCriteria?: string;
}

export interface ActionUpdateInput {
  operation: "reschedule" | "cancel" | "execute";
  scheduledAt?: string;
  reason?: string;
  version: number;
}

export const ACTION_OUTCOMES = [
  "no_response", "replied", "interested", "scheduled", "won", "rejected", "service_needed",
] as const;
export type ActionOutcome = typeof ACTION_OUTCOMES[number];

export interface ManualActionInput {
  profileId: string;
  opportunityType: OpportunityType;
  title: string;
  objective: string;
  followUpMethod?: string;
  priority: OpportunityPriority;
  scheduledAt: string;
  resultCriteria?: string;
  productKey?: string;
  productName?: string;
}

export const TALK_TRACK_INTENTS = ["maintenance", "follow_up", "sales"] as const;
export type TalkTrackIntent = typeof TALK_TRACK_INTENTS[number];

export interface TalkTrackMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TalkTrackRequest {
  intent: TalkTrackIntent;
  message: string;
  history: TalkTrackMessage[];
}

export interface TalkTrackContext {
  customerName: string;
  organization: string | null;
  relationshipStage: string;
  customerSummary: string;
  tags: string[];
  opportunityType: StoredOpportunityType;
  title: string;
  objective: string;
  reason: string;
  followUpMethod: string | null;
  productName: string | null;
  resultCriteria: string | null;
  customerProductStates: unknown[];
  recentFacts: Array<{ text: string; occurredAt: string | null }>;
  productMaterial: Record<string, unknown> | null;
}

export interface ActionResultInput {
  outcome: ActionOutcome;
  customerQuote?: string;
  note?: string;
  nextAction?: string;
  nextActionAt?: string;
  confirmedRelationshipStage?: "lead" | "prospect" | "customer" | "inactive" | "lost";
}

export const FOLLOW_UP_ACTION_OPERATIONS = [
  "create", "accept", "snooze", "dismiss", "reschedule", "cancel", "execute",
] as const;
export type FollowUpActionOperation = typeof FOLLOW_UP_ACTION_OPERATIONS[number];

export const OUTREACH_CHANNELS = ["wechat", "phone", "email", "visit"] as const;
export type OutreachChannel = typeof OUTREACH_CHANNELS[number];

export interface FollowUpActionPrepareInput {
  operation: FollowUpActionOperation;
  customerMention?: string;
  profileId?: string;
  opportunityId?: string;
  actionId?: string;
  opportunityType?: OpportunityType;
  title?: string;
  objective?: string;
  followUpMethod?: string;
  priority?: OpportunityPriority;
  scheduledAt?: string;
  resultCriteria?: string;
  productName?: string;
  reason?: string;
  snoozedUntil?: string;
  version?: number;
}

export interface OutreachGenerateInput {
  itemId?: string;
  profileId?: string;
  intent: TalkTrackIntent;
  channel?: OutreachChannel;
  message: string;
  history?: TalkTrackMessage[];
}

export interface OutreachDraft {
  id: string;
  profileId: string;
  taskId: string | null;
  opportunityId: string | null;
  channel: OutreachChannel;
  objective: string;
  content: string;
  version: number;
  usedAt: string | null;
  modelId: string | null;
}
