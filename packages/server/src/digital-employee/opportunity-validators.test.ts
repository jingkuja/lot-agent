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
      modelId: "deepseek-v4-pro",
    })).toEqual({
      intent: "sales",
      message: "改成适合微信的简短版本",
      history: [{ role: "assistant", content: "上一版话术" }],
      modelId: "deepseek-v4-pro",
    });
  });

  it("rejects oversized talk-track history", () => {
    expect(() => parseTalkTrackRequest({
      intent: "follow_up",
      message: "继续",
      history: Array.from({ length: 13 }, () => ({ role: "user", content: "调整" })),
    })).toThrow("话术对话历史格式无效");
  });

  it("accepts create-action with a selected profile id", () => {
    expect(parseCreateAction({
      profileId: "11111111-1111-1111-1111-111111111111",
      opportunityType: "event_invitation",
      title: "邀请李静参加周四活动",
      objective: "确认是否到场并收集顾虑",
      followUpMethod: "企微/微信",
      priority: "normal",
      scheduledAt: "2026-09-08T02:00:00.000Z",
      resultCriteria: "获得有效回复或下一步",
      productName: "企业云",
    })).toMatchObject({
      profileId: "11111111-1111-1111-1111-111111111111",
      opportunityType: "event_invitation",
      title: "邀请李静参加周四活动",
      objective: "确认是否到场并收集顾虑",
      followUpMethod: "企微/微信",
      priority: "normal",
      resultCriteria: "获得有效回复或下一步",
      productName: "企业云",
    });
  });

  it("rejects create-action when profileId is empty", () => {
    expect(() => parseCreateAction({
      profileId: "",
      opportunityType: "event_invitation",
      title: "跟进",
      objective: "确认意向",
      priority: "normal",
      scheduledAt: "2026-09-08T02:00:00.000Z",
    })).toThrow("profileId格式无效");
  });

  it("rejects create-action when profileId is missing", () => {
    expect(() => parseCreateAction({
      opportunityType: "event_invitation",
      title: "跟进",
      objective: "确认意向",
      priority: "normal",
      scheduledAt: "2026-09-08T02:00:00.000Z",
    })).toThrow("profileId不能为空");
  });
});
