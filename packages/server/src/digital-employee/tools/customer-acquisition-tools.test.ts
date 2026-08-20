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
