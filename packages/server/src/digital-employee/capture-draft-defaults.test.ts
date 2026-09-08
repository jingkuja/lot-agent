import { describe, expect, it } from "vitest";
import { withCaptureDraftDefaults } from "./service.js";

describe("withCaptureDraftDefaults", () => {
  it("fills soft journey and relationship fields from eventType", () => {
    const result = withCaptureDraftDefaults({
      customerMention: "李姐",
      eventType: "requirement",
      productName: "企业版",
    });
    expect(result.facts).toMatchObject({
      journeyStage: "evaluating",
      relationshipStage: "prospect",
    });
    expect(result.proposedStatePatch).toMatchObject({
      journeyStage: "evaluating",
      relationshipStage: "prospect",
    });
    expect(result.confidence).toBe(0.7);
  });

  it("does not invent high-impact purchased stage from purchase event alone", () => {
    const result = withCaptureDraftDefaults({
      customerMention: "张总",
      eventType: "purchase",
    });
    expect(result.facts?.relationshipStage).toBe("customer");
    expect(result.facts?.journeyStage).toBeUndefined();
  });

  it("marks complaint risk defaults without overriding explicit facts", () => {
    const result = withCaptureDraftDefaults({
      customerMention: "王工",
      eventType: "complaint",
      facts: { sentiment: "mixed", health: "watch" },
    });
    expect(result.facts).toMatchObject({
      sentiment: "mixed",
      health: "watch",
      satisfaction: "dissatisfied",
    });
  });
});
