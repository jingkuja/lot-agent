/**
 * Customer-profile domain types.  UI calls the feature "用户画像", while the
 * code deliberately uses CustomerProfile so it can never be confused with the
 * authenticated application user.
 */

export const RELATIONSHIP_STAGES = ["lead", "prospect", "customer", "inactive", "lost"] as const;
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number];

export const HEALTH_VALUES = ["healthy", "watch", "at_risk"] as const;
export type Health = (typeof HEALTH_VALUES)[number];

export const CUSTOMER_KINDS = ["person", "organization_contact"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

export const PROFILE_STATUSES = ["active", "archived"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const JOURNEY_STAGES = [
  "unknown",
  "evaluating",
  "trial",
  "purchased",
  "using",
  "renewal",
  "paused",
  "lost",
  "churned",
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export const SENTIMENT_VALUES = ["positive", "neutral", "negative", "mixed", "unknown"] as const;
export type Sentiment = (typeof SENTIMENT_VALUES)[number];

export const SATISFACTION_VALUES = ["satisfied", "neutral", "dissatisfied", "unknown"] as const;
export type Satisfaction = (typeof SATISFACTION_VALUES)[number];

export const OBSERVATION_TYPES = [
  "contact",
  "requirement",
  "purchase_intent",
  "trial",
  "purchase",
  "product_feedback",
  "complaint",
  "delivery",
  "renewal",
  "churn",
  "note",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const OBSERVATION_SOURCES = [
  "agent_message",
  "manual",
  "import",
  "transaction",
  "support",
] as const;
export type ObservationSourceType = (typeof OBSERVATION_SOURCES)[number];

export type JsonObject = Record<string, unknown>;

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
  customerKind: CustomerKind;
  organization: string | null;
  department: string | null;
  title: string | null;
  /** Free text, intentionally not split into geographic levels. */
  customerRegion: string | null;
  /** Decrypted only for an owning user's detail request. */
  contact: CustomerContact | null;
  source: string | null;
  relationshipStage: RelationshipStage;
  overallHealth: Health;
  tags: string[];
  customFields: JsonObject;
  summary: string;
  summaryVersion: number;
  manualLockFields: string[];
  lastObservedAt: string | null;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  version: number;
  status: ProfileStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Internal persistence shape: the repository never decrypts PII. */
export interface StoredCustomerProfile extends Omit<CustomerProfile, "contact"> {
  contactCiphertext: string | null;
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
  userId: string;
  profileId: string;
  sourceType: ObservationSourceType;
  sourceId: string;
  sourceLocator: JsonObject;
  rawText: string;
  rawTextHash: string;
  occurredAt: string | null;
  supersedesId: string | null;
  createdAt: string;
}

export type ExtractionApplyStatus = "applied" | "partial" | "rejected";

export interface CustomerObservationExtraction {
  id: string;
  userId: string;
  profileId: string;
  observationId: string;
  eventType: ObservationType;
  productKey: string | null;
  productName: string | null;
  extractedFacts: JsonObject;
  proposedPatch: JsonObject;
  applyStatus: ExtractionApplyStatus;
  confidence: number | null;
  modelId: string | null;
  promptVersion: string;
  schemaVersion: string;
  supersedesExtractionId: string | null;
  createdAt: string;
  appliedAt: string | null;
}

export interface CustomerStateChange {
  id: string;
  userId: string;
  profileId: string;
  productStateId: string | null;
  sourceObservationId: string | null;
  sourceExtractionId: string | null;
  actorType: "user" | "ai_confirmed" | "system";
  beforeState: JsonObject;
  patch: JsonObject;
  afterState: JsonObject;
  reason: string | null;
  createdAt: string;
}

export type CaptureDraftStatus =
  | "prepared"
  | "awaiting_confirmation"
  | "applied"
  | "rejected"
  | "expired";

export interface CustomerCaptureDraft {
  id: string;
  userId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  rawText: string;
  candidateProfileIds: string[];
  proposedObservation: JsonObject;
  ambiguities: string[];
  status: CaptureDraftStatus;
  appliedProfileId: string | null;
  appliedObservationId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileListFilters {
  page: number;
  limit: number;
  query?: string;
  relationshipStage?: RelationshipStage;
  health?: Health;
  tag?: string;
  status?: ProfileStatus;
}

export interface ProfileListResult {
  items: CustomerProfile[];
  page: number;
  limit: number;
  total: number;
}

export interface CreateProductStateInput {
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
}

export interface CreateCustomerProfileInput {
  displayName: string;
  aliases?: string[];
  customerKind?: CustomerKind;
  organization?: string | null;
  department?: string | null;
  title?: string | null;
  customerRegion?: string | null;
  contact?: CustomerContact | null;
  source?: string | null;
  relationshipStage?: RelationshipStage;
  overallHealth?: Health;
  tags?: string[];
  customFields?: JsonObject;
  manualLockFields?: string[];
  productStates?: CreateProductStateInput[];
}

export interface UpdateCustomerProfileInput {
  version: number;
  displayName?: string;
  aliases?: string[];
  customerKind?: CustomerKind;
  organization?: string | null;
  department?: string | null;
  title?: string | null;
  customerRegion?: string | null;
  /** undefined preserves contact; null clears it. */
  contact?: CustomerContact | null;
  source?: string | null;
  relationshipStage?: RelationshipStage;
  overallHealth?: Health;
  tags?: string[];
  customFields?: JsonObject;
  manualLockFields?: string[];
}

export interface UpdateProductStateInput extends Omit<CreateProductStateInput, "productName" | "productKey"> {
  version?: number;
  productName?: string;
}

export interface ObservationFacts {
  sentiment?: Sentiment;
  satisfaction?: Satisfaction;
  health?: Health;
  relationshipStage?: RelationshipStage;
  journeyStage?: JourneyStage;
  needs?: unknown[];
  objections?: unknown[];
  currentIssues?: unknown[];
}

export interface CustomerCaptureInput {
  customerMention: string;
  eventType: ObservationType;
  productName?: string;
  occurredAt?: string | null;
  facts?: ObservationFacts;
  proposedStatePatch?: ObservationFacts;
  uncertainties?: string[];
  confidence?: number | null;
}

export interface PrepareCaptureResult {
  draftId: string;
  status: "ready" | "needs_clarification";
  profile?: { id: string; displayName: string };
  candidates: Array<{ id: string; displayName: string; customerRegion?: string | null }>;
  ambiguities: string[];
  clarification?: {
    question: string;
    options: string[];
    kind: "identity" | "new_profile" | "journey_stage" | "locked_field";
  };
}

export interface CommitCaptureInput {
  draftId: string;
  /** Must be one of the draft's candidates if the identity was ambiguous. */
  profileId?: string;
  /** Only valid when the draft explicitly asks the user to confirm a new profile. */
  createProfile?: { displayName?: string };
  /** Explicit user answer for a product-stage ambiguity. */
  confirmedJourneyStage?: JourneyStage;
}

export interface CommitCaptureResult {
  profile: CustomerProfile;
  observation: CustomerObservation;
  extraction: CustomerObservationExtraction;
  appliedFields: string[];
  skippedFields: string[];
  alreadyApplied?: boolean;
}

export interface AddManualObservationInput {
  rawText: string;
  eventType?: ObservationType;
  productName?: string;
  occurredAt?: string | null;
  facts?: ObservationFacts;
  proposedStatePatch?: ObservationFacts;
}

export type ProfileChangeOperation = "create" | "update";
export type ProfileChangeDraftStatus = "prepared" | "awaiting_confirmation" | "applied" | "expired";

export interface CustomerProfileChangeDraft {
  id: string;
  userId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  operation: ProfileChangeOperation;
  customerMention: string | null;
  candidateProfileIds: string[];
  proposedPatch: JsonObject;
  targetVersion: number | null;
  risks: string[];
  status: ProfileChangeDraftStatus;
  appliedProfileId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileChangeInput {
  operation: ProfileChangeOperation;
  customerMention?: string;
  displayName?: string;
  aliases?: string[];
  organization?: string | null;
  department?: string | null;
  title?: string | null;
  customerRegion?: string | null;
  source?: string | null;
  relationshipStage?: RelationshipStage;
  overallHealth?: Health;
  tags?: string[];
}

export interface PrepareProfileChangeResult {
  draftId: string;
  status: "ready" | "needs_confirmation";
  operation: ProfileChangeOperation;
  candidates: Array<{ id: string; displayName: string; customerRegion: string | null }>;
  risks: string[];
  question?: string;
  options?: string[];
}

export interface CommitProfileChangeInput {
  draftId: string;
  profileId?: string;
  confirm?: boolean;
  continueCreate?: boolean;
}
