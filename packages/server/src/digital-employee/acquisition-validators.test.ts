import { describe, expect, it } from "vitest";
import { parseAcquisitionLead, parseCreateCampaignAsset, parseDeployment, parseSegmentInput } from "./acquisition-validators.js";

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

  it("accepts a selected generation model id", () => {
    expect(parseCreateCampaignAsset({
      assetType: "video", prompt: "生成视频", campaignId: "00000000-0000-4000-8000-000000000201",
      modelId: "doubao-seedance-2.0",
    })).toMatchObject({ modelId: "doubao-seedance-2.0" });
  });

  it("accepts knowledge bases, uploaded files and image settings", () => {
    expect(parseCreateCampaignAsset({
      assetType: "copy", prompt: "写朋友圈文案", campaignId: "00000000-0000-4000-8000-000000000201",
      knowledgeBaseIds: ["kb-1"],
      attachments: [{
        assetId: "00000000-0000-4000-8000-000000000301",
        filename: "brief.pdf", mime: "application/pdf", size: 1200,
        url: "/static/uploads/brief.pdf", kind: "doc",
      }],
    })).toMatchObject({
      knowledgeBaseIds: ["kb-1"],
      attachments: [expect.objectContaining({ filename: "brief.pdf" })],
    });
  });

  it("accepts video generation settings from the shared input UI", () => {
    expect(parseCreateCampaignAsset({
      assetType: "video", prompt: "生成视频", campaignId: "00000000-0000-4000-8000-000000000201",
      mediaSettings: { durationSec: 5, ratio: "9:16", size: "720x1280", generate_audio: false },
      input_reference: ["/static/uploads/a.png"],
      first_frame: "/static/uploads/first.png",
    })).toMatchObject({
      mediaSettings: { durationSec: 5, ratio: "9:16", size: "720x1280", generate_audio: false },
      input_reference: ["/static/uploads/a.png"],
      first_frame: "/static/uploads/first.png",
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

  it("requires a display name for acquisition lead return", () => {
    expect(() => parseAcquisitionLead({})).toThrow("咨询者姓名");
    expect(parseAcquisitionLead({ displayName: "李静", sourceCampaign: "分享会" })).toMatchObject({
      displayName: "李静", sourceCampaign: "分享会",
    });
  });
});
