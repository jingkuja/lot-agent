import { describe, expect, it } from "vitest";
import { projectObservation } from "./state-projector.js";
import type { CustomerProductState, CustomerProfile } from "../types.js";

function profile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    id: "p1", userId: "u1", ownerUserId: "u1", displayName: "张哥", aliases: [], customerKind: "person",
    organization: null, department: null, title: null, customerRegion: null, contact: null, source: null,
    relationshipStage: "prospect", overallHealth: "healthy", tags: [], customFields: {}, summary: "",
    summaryVersion: 1, manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
    version: 1, status: "active", archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function product(overrides: Partial<CustomerProductState> = {}): CustomerProductState {
  return {
    id: "s1", userId: "u1", profileId: "p1", productKey: "edge", productName: "边缘算力",
    journeyStage: "using", sentiment: "neutral", satisfaction: "neutral", health: "healthy",
    needs: [], objections: [], currentIssues: [], manualLockFields: [], lastObservationId: null,
    lastConfirmedAt: null, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("projectObservation", () => {
  it("keeps a known using stage when negative feedback arrives", () => {
    const result = projectObservation(profile({ relationshipStage: "customer" }), product(), {
      eventType: "product_feedback",
      facts: { sentiment: "negative", satisfaction: "dissatisfied", currentIssues: ["高峰期性能不稳定"] },
      proposedPatch: { journeyStage: "lost" },
      actor: "ai_confirmed",
    });

    expect(result.requiresJourneyConfirmation).toBe(true);
    // The preparation service will ask first, and no unconfirmed stage patch
    // is emitted. The safe feedback facts still remain available to record.
    expect(result.productPatch.journeyStage).toBeUndefined();
    expect(result.productPatch.satisfaction).toBe("dissatisfied");
    expect(result.productPatch.health).toBe("at_risk");
  });

  it("does not turn evaluation into loss from a negative reaction alone", () => {
    const result = projectObservation(profile(), product({ journeyStage: "evaluating" }), {
      eventType: "product_feedback",
      facts: { sentiment: "negative", objections: ["性能不符合预期"] },
      proposedPatch: { journeyStage: "lost" },
      actor: "ai_confirmed",
    });

    expect(result.requiresJourneyConfirmation).toBe(true);
    expect(result.productPatch).toMatchObject({ sentiment: "negative", objections: ["性能不符合预期"] });
    expect(result.productPatch.journeyStage).toBeUndefined();
  });

  it("accepts an explicit purchase/use confirmation and promotes the overall relationship", () => {
    const result = projectObservation(profile(), product({ journeyStage: "evaluating" }), {
      eventType: "purchase",
      facts: { satisfaction: "dissatisfied" },
      confirmedJourneyStage: "using",
      actor: "ai_confirmed",
    });

    expect(result.requiresJourneyConfirmation).toBe(false);
    expect(result.profilePatch.relationshipStage).toBe("customer");
    expect(result.productPatch).toMatchObject({ journeyStage: "using", satisfaction: "dissatisfied" });
  });

  it("never lets agent extraction overwrite manually locked fields", () => {
    const result = projectObservation(
      profile({ manualLockFields: ["relationshipStage"] }),
      product({ manualLockFields: ["journeyStage", "health"] }),
      {
        eventType: "purchase",
        facts: { relationshipStage: "customer", health: "at_risk", journeyStage: "using" },
        actor: "ai_confirmed",
      }
    );

    expect(result.profilePatch.relationshipStage).toBeUndefined();
    expect(result.productPatch.journeyStage).toBeUndefined();
    expect(result.productPatch.health).toBeUndefined();
    expect(result.skippedFields).toEqual(expect.arrayContaining(["relationshipStage", "journeyStage", "health"]));
  });
});
