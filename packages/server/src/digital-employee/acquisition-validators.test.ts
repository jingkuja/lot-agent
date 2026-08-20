import { describe, expect, it } from "vitest";
import { parseCreateCampaignAsset, parseDeployment, parseSegmentInput } from "./acquisition-validators.js";

describe("customer acquisition validators", () => {
  it("requires a cohort snapshot, segment or explicit public audience", () => {
    expect(() => parseCreateCampaignAsset({
      assetType: "copy", prompt: "生成文案", productId: "p1", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约咨询",
    })).toThrow("请选择客群或填写明确的公开受众");
  });

  it("accepts safe structured segment criteria", () => {
    expect(parseSegmentInput({
      name: "华东制造业潜客",
      criteria: { relationshipStages: ["lead", "prospect"], activeWithinDays: 30, excludeAtRisk: true },
    })).toMatchObject({
      name: "华东制造业潜客",
      criteria: { relationshipStages: ["lead", "prospect"], activeWithinDays: 30, excludeAtRisk: true },
    });
  });

  it("requires a name for custom deployment platforms", () => {
    expect(() => parseDeployment({ platform: "other", status: "deployed", deployedAt: new Date().toISOString() }))
      .toThrow("其他平台需要填写名称");
  });
});
