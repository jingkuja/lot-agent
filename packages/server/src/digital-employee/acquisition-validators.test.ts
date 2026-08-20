import { describe, expect, it } from "vitest";
import { parseCreateCampaignAsset, parseDeployment, parseSegmentInput } from "./acquisition-validators.js";

describe("customer acquisition validators", () => {
  it("requires a cohort snapshot, segment or explicit public audience", () => {
    expect(() => parseCreateCampaignAsset({
      assetType: "copy", prompt: "生成文案", productId: "00000000-0000-4000-8000-000000000001", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约咨询",
    })).toThrow("请选择客群、填写公开受众，或指定已有营销活动");
  });

  it("lets an existing campaign receive more assets without repeating audience", () => {
    expect(parseCreateCampaignAsset({
      assetType: "poster", prompt: "同一主题海报", campaignId: "00000000-0000-4000-8000-000000000201",
    })).toMatchObject({
      assetType: "poster", campaignId: "00000000-0000-4000-8000-000000000201",
    });
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
