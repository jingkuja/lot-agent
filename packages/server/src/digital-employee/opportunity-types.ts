export const OPPORTUNITY_TYPES = [
  "prospect_progress", "silent_reengage", "event_invitation", "renewal", "risk_recovery",
  "new_lead_contact", "trial_conversion", "repurchase", "referral", "cohort_marketing",
] as const;
export type OpportunityType = typeof OPPORTUNITY_TYPES[number];

export const READINESS_VALUES = ["actionable", "tryable", "needs_info", "paused"] as const;
export type OpportunityReadiness = typeof READINESS_VALUES[number];
export const PRIORITY_VALUES = ["low", "normal", "high"] as const;
export type OpportunityPriority = typeof PRIORITY_VALUES[number];
export const OPPORTUNITY_VIEWS = ["pending", "in_progress", "awaiting_result", "completed"] as const;
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
  opportunityType: OpportunityType;
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

export interface OpportunityListFilters {
  view: OpportunityView;
  readiness?: OpportunityReadiness;
  priority?: OpportunityPriority;
  opportunityType?: OpportunityType;
  relationshipStage?: string;
  product?: string;
  suggestedFrom?: string;
  suggestedTo?: string;
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
  prepareContent?: boolean;
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

export interface ActionResultInput {
  outcome: ActionOutcome;
  customerQuote?: string;
  note?: string;
  nextAction?: string;
  nextActionAt?: string;
  confirmedRelationshipStage?: "lead" | "prospect" | "customer" | "inactive" | "lost";
}
