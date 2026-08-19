import { describe, expect, it } from "vitest";
import { parseCreateAction, parseOpportunityList, parseTalkTrackRequest } from "./opportunity-validators.js";

describe("opportunity validators", () => {
  it("accepts the today personal-work view", () => {
    expect(parseOpportunityList({ view: "today" }).view).toBe("today");
  });

  it("rejects cohort marketing actions in the personal advisor", () => {
    expect(() => parseCreateAction({
      profileId: "p1",
      opportunityType: "cohort_marketing",
      title: "客群活动",
      objective: "批量获客",
      priority: "normal",
      scheduledAt: "2026-08-20T01:00:00.000Z",
    })).toThrow("opportunityType取值无效");
  });

  it("accepts a bounded personal talk-track conversation", () => {
    expect(parseTalkTrackRequest({
      intent: "sales",
      message: "改成适合微信的简短版本",
      history: [{ role: "assistant", content: "上一版话术" }],
    })).toEqual({
      intent: "sales",
      message: "改成适合微信的简短版本",
      history: [{ role: "assistant", content: "上一版话术" }],
    });
  });

  it("rejects oversized talk-track history", () => {
    expect(() => parseTalkTrackRequest({
      intent: "follow_up",
      message: "继续",
      history: Array.from({ length: 13 }, () => ({ role: "user", content: "调整" })),
    })).toThrow("话术对话历史格式无效");
  });
});
