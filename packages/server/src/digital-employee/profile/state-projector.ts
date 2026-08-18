import type {
  CustomerProductState,
  CustomerProfile,
  Health,
  JourneyStage,
  ObservationFacts,
  ObservationType,
  RelationshipStage,
} from "../types.js";

export interface ProjectionInput {
  eventType: ObservationType;
  facts?: ObservationFacts;
  proposedPatch?: ObservationFacts;
  /** A user explicitly answered a stage clarification; it has higher authority than a model proposal. */
  confirmedJourneyStage?: JourneyStage;
  /** Manual page edits may intentionally override a field lock. Agent extraction may not. */
  actor: "user" | "ai_confirmed";
}

export interface ProfileProjectionPatch {
  relationshipStage?: RelationshipStage;
  overallHealth?: Health;
}

export interface ProductProjectionPatch {
  journeyStage?: JourneyStage;
  sentiment?: CustomerProductState["sentiment"];
  satisfaction?: CustomerProductState["satisfaction"];
  health?: Health;
  needs?: unknown[];
  objections?: unknown[];
  currentIssues?: unknown[];
}

export interface ProjectionResult {
  profilePatch: ProfileProjectionPatch;
  productPatch: ProductProjectionPatch;
  skippedFields: string[];
  warnings: string[];
  /** prepare_customer_capture must obtain an answer before this is applied. */
  requiresJourneyConfirmation: boolean;
}

const HIGH_IMPACT_JOURNEY = new Set<JourneyStage>(["purchased", "using", "lost", "churned"]);
const NEGATIVE_EVENTS = new Set<ObservationType>(["product_feedback", "complaint", "churn"]);

function hasField<T extends object>(source: T | undefined, field: keyof T): boolean {
  return !!source && source[field] !== undefined;
}

function locked(fields: string[], name: string): boolean {
  return fields.includes(name);
}

/**
 * Pure projection policy shared by agent capture and manual observation writes.
 * It deliberately only returns a patch: persistence and audit records stay in
 * the service layer, making this behavior straightforward to unit test.
 */
export function projectObservation(
  profile: CustomerProfile,
  product: CustomerProductState | undefined,
  input: ProjectionInput
): ProjectionResult {
  const source = { ...(input.facts ?? {}), ...(input.proposedPatch ?? {}) };
  const productPatch: ProductProjectionPatch = {};
  const profilePatch: ProfileProjectionPatch = {};
  const skippedFields: string[] = [];
  const warnings: string[] = [];
  const isManual = input.actor === "user";
  const productLocks = product?.manualLockFields ?? [];

  const requestedJourney = input.confirmedJourneyStage ?? source.journeyStage;
  const currentJourney = product?.journeyStage ?? "unknown";
  const changingJourney = requestedJourney !== undefined && requestedJourney !== currentJourney;
  const needsJourneyConfirmation =
    !isManual &&
    !input.confirmedJourneyStage &&
    changingJourney &&
    HIGH_IMPACT_JOURNEY.has(requestedJourney!);

  if (hasField(source, "relationshipStage")) {
    if (!isManual && locked(profile.manualLockFields, "relationshipStage")) {
      skippedFields.push("relationshipStage");
      warnings.push("总体关系阶段已由人工锁定，未被自动改写。");
    } else if (source.relationshipStage !== profile.relationshipStage) {
      profilePatch.relationshipStage = source.relationshipStage;
    }
  }

  if (hasField(source, "health")) {
    if (!isManual && locked(productLocks, "health")) {
      skippedFields.push("health");
      warnings.push("产品健康度已由人工锁定，未被自动改写。");
    } else if (source.health !== product?.health) {
      productPatch.health = source.health;
    }
  }

  if (hasField(source, "sentiment")) {
    if (!isManual && locked(productLocks, "sentiment")) {
      skippedFields.push("sentiment");
    } else if (source.sentiment !== product?.sentiment) {
      productPatch.sentiment = source.sentiment;
    }
  }

  if (hasField(source, "satisfaction")) {
    if (!isManual && locked(productLocks, "satisfaction")) {
      skippedFields.push("satisfaction");
    } else if (source.satisfaction !== product?.satisfaction) {
      productPatch.satisfaction = source.satisfaction;
    }
  }

  for (const field of ["needs", "objections", "currentIssues"] as const) {
    if (!hasField(source, field)) continue;
    if (!isManual && locked(productLocks, field)) {
      skippedFields.push(field);
      continue;
    }
    const requested = source[field];
    const current = product?.[field];
    // Arrays are intentional snapshots of the current effective state. JSON
    // stringification is sufficient here because validation constrains them to
    // plain JSON data before reaching this pure function.
    if (JSON.stringify(requested) !== JSON.stringify(current)) productPatch[field] = requested;
  }

  if (requestedJourney !== undefined) {
    if (!isManual && locked(productLocks, "journeyStage")) {
      skippedFields.push("journeyStage");
      warnings.push("产品旅程阶段已由人工锁定，未被自动改写。");
    } else if (needsJourneyConfirmation) {
      skippedFields.push("journeyStage");
    } else if (
      !input.confirmedJourneyStage &&
      currentJourney === "using" &&
      requestedJourney !== "using" &&
      NEGATIVE_EVENTS.has(input.eventType)
    ) {
      // A negative support signal is not evidence that an existing customer has
      // stopped using the product. Keep the stage, surface the risk instead.
      skippedFields.push("journeyStage");
      warnings.push("负面使用反馈只更新满意度和风险，不会自动改变已确认的使用阶段。");
    } else if (requestedJourney !== currentJourney) {
      productPatch.journeyStage = requestedJourney;
    }
  }

  // Negative feedback while a product is known to be used is a service risk,
  // not a sales-stage rollback. Fill safe defaults only when the model did not
  // state a different explicit value.
  const negative =
    NEGATIVE_EVENTS.has(input.eventType) &&
    (source.sentiment === "negative" || source.satisfaction === "dissatisfied" || input.eventType === "complaint");
  if (negative && (currentJourney === "using" || requestedJourney === "using")) {
    if (!productPatch.health && product?.health !== "at_risk" && !( !isManual && locked(productLocks, "health") )) {
      productPatch.health = "at_risk";
    }
    if (!productPatch.satisfaction && product?.satisfaction !== "dissatisfied" && !( !isManual && locked(productLocks, "satisfaction") )) {
      productPatch.satisfaction = "dissatisfied";
    }
  }

  // A confirmed purchase/use answer is explicit customer-provided evidence.
  // It may safely promote the overall relationship unless an operator locked it.
  if (
    (input.confirmedJourneyStage === "purchased" || input.confirmedJourneyStage === "using") &&
    profile.relationshipStage !== "customer"
  ) {
    if (!isManual && locked(profile.manualLockFields, "relationshipStage")) {
      skippedFields.push("relationshipStage");
    } else {
      profilePatch.relationshipStage = "customer";
    }
  }

  return {
    profilePatch,
    productPatch,
    skippedFields: [...new Set(skippedFields)],
    warnings,
    requiresJourneyConfirmation: needsJourneyConfirmation,
  };
}

export function hasProjectionChanges(result: ProjectionResult): boolean {
  return Object.keys(result.profilePatch).length > 0 || Object.keys(result.productPatch).length > 0;
}

export function productKeyFor(productName: string): string {
  const normalized = productName
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "product").slice(0, 160);
}
