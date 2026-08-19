import { describe, expect, it } from "vitest";
import { discoverByRules, type DiscoveryCandidate } from "./opportunity-rules.js";
import { applyAdvicePatches } from "./opportunity-service.js";

const base: DiscoveryCandidate = {
  profileId: "p1", displayName: "李经理", relationshipStage: "prospect", overallHealth: "healthy",
  summary: "正在评估企业版", lastContactAt: "2026-08-10T00:00:00.000Z", nextFollowUpAt: null,
  updatedAt: "2026-08-18T00:00:00.000Z",
  latestObservation: { id: "o1", rawText: "客户索要了报价单", eventType: "requirement", occurredAt: "2026-08-18T00:00:00.000Z" },
  products: [{ productKey: "enterprise", productName: "企业版", journeyStage: "evaluating", satisfaction: "unknown", health: "healthy", currentIssues: [], updatedAt: "2026-08-18T00:00:00.000Z" }],
};

describe("opportunity discovery rules", () => {
  it("creates an explainable prospect opportunity", () => {
    const result = discoverByRules(base, new Date("2026-08-19T00:00:00.000Z"));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "prospect_progress", readiness: "actionable", productName: "企业版" });
    expect(result[0].evidence[0]).toMatchObject({ sourceId: "o1", occurredAt: "2026-08-18T00:00:00.000Z" });
  });

  it("emits risk recovery and blocks promotional opportunities", () => {
    const result = discoverByRules({ ...base, overallHealth: "at_risk" }, new Date("2026-08-19T00:00:00.000Z"));
    expect(result.map((item) => item.type)).toEqual(["risk_recovery", "prospect_progress"]);
    expect(result[1].risks).toContainEqual(expect.objectContaining({ code: "active_risk", blocking: true }));
  });

  it("does not create promotional opportunities for lost customers", () => {
    expect(discoverByRules({ ...base, relationshipStage: "lost" })).toEqual([]);
  });

  it("lets model advice improve wording without changing server-owned evidence or risk", () => {
    const rules = discoverByRules(base, new Date("2026-08-19T00:00:00.000Z"));
    const enhanced = applyAdvicePatches(rules, [{
      dedupKey: rules[0].dedupKey, title: "今天确认企业版评估进度", objective: "预约下一次产品演示",
    }]);
    expect(enhanced[0].title).toBe("今天确认企业版评估进度");
    expect(enhanced[0].objective).toBe("预约下一次产品演示");
    expect(enhanced[0].evidence).toEqual(rules[0].evidence);
    expect(enhanced[0].dedupKey).toBe(rules[0].dedupKey);
  });

  it("rejects model wording that injects contact details", () => {
    const rules = discoverByRules(base, new Date("2026-08-19T00:00:00.000Z"));
    const enhanced = applyAdvicePatches(rules, [{ dedupKey: rules[0].dedupKey, title: "联系 13800138000" }]);
    expect(enhanced[0].title).toBe(rules[0].title);
  });
});
