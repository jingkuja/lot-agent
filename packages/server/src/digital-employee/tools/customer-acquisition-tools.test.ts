import { describe, expect, it, vi } from "vitest";
import { createCustomerAcquisitionTools } from "./customer-acquisition-tools.js";

function find(name: string, service: Record<string, unknown>) {
  return createCustomerAcquisitionTools(service as any).find((tool) => tool.name === name)!;
}

const context = {
  userId: "u1",
  workingDirectory: "/tmp",
  featureScope: "customer-acquisition",
};

describe("customer acquisition agent tools", () => {
  it("returns only the service aggregate cohort view", async () => {
    const service = { getCohortInsights: vi.fn(async () => ({ overall: { metrics: { totalProfiles: 8 } }, segments: [] })) };
    const result = await find("analyze_customer_cohort", service).execute({}, context);
    expect(service.getCohortInsights).toHaveBeenCalledWith("u1");
    expect(JSON.parse(result.content)).toMatchObject({ overall: { metrics: { totalProfiles: 8 } } });
  });

  it("rejects acquisition tools outside the acquisition feature scope", async () => {
    const service = { getCohortInsights: vi.fn() };
    const result = await find("analyze_customer_cohort", service).execute({}, { ...context, featureScope: "customer-profile" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("不在获客宝作用域");
    expect(service.getCohortInsights).not.toHaveBeenCalled();
  });

  it("exposes segment, campaign, rewrite and result tools", () => {
    const names = createCustomerAcquisitionTools({} as any).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "prepare_customer_segment", "commit_customer_segment", "evaluate_segment_product_fit",
      "prepare_marketing_campaign", "commit_marketing_campaign", "search_marketing_campaigns",
      "get_marketing_campaign", "search_campaign_opportunities", "accept_campaign_opportunity",
      "generate_campaign_poster",
      "generate_campaign_video", "rewrite_campaign_asset", "record_campaign_usage",
      "prepare_campaign_result", "commit_campaign_result", "archive_marketing_asset",
    ]));
  });

  it("prepares a segment save and requires confirmation", async () => {
    const prepareCustomerSegment = vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000211",
      question: "确认保存动态客群「华东制造业」？",
      options: ["确认保存", "取消"],
      preview: { name: "华东制造业", metrics: { totalProfiles: 8 } },
    }));
    const result = await find("prepare_customer_segment", { prepareCustomerSegment }).execute({
      name: "华东制造业",
      criteria: { regions: ["华东"], relationshipStages: ["prospect"] },
    }, context);
    expect(prepareCustomerSegment).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "华东制造业" }), expect.any(Object));
    expect(result.content).toContain("commit_customer_segment");
    expect(result.content).toContain("ask_user");
  });

  it("rewrites a campaign asset from an existing library item", async () => {
    const rewriteAsset = vi.fn(async () => ({ id: "a2", title: "更克制的文案", assetType: "text" }));
    const result = await find("rewrite_campaign_asset", { rewriteAsset }).execute({
      assetId: "00000000-0000-4000-8000-000000000012",
      instruction: "更克制，不能出现未确认的性能数字",
    }, context);
    expect(rewriteAsset).toHaveBeenCalledWith(
      "u1",
      "00000000-0000-4000-8000-000000000012",
      "更克制，不能出现未确认的性能数字"
    );
    expect(JSON.parse(result.content).asset.id).toBe("a2");
  });

  it("forces conversational asset generation to copy", async () => {
    const service = { createAsset: vi.fn(async (_userId, input) => ({ id: "a1", title: "新文案", assetType: input.assetType })) };
    const result = await find("generate_campaign_copy", service).execute({
      prompt: "为公开课写一条克制的朋友圈文案",
      publicAudience: "关注边缘算力的华东制造业潜客",
      productId: "00000000-0000-4000-8000-000000000001",
      objective: "活动报名",
      channels: ["朋友圈"],
      callToAction: "预约报名",
    }, context);
    expect(service.createAsset).toHaveBeenCalledWith("u1", expect.objectContaining({ assetType: "copy" }));
    expect(JSON.parse(result.content).asset).toMatchObject({ id: "a1", assetType: "copy" });
  });
});
