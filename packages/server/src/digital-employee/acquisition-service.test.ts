import { describe, expect, it, vi } from "vitest";
import { CustomerAcquisitionService } from "./acquisition-service.js";

describe("CustomerAcquisitionService", () => {
  it("sends only aggregate audience data and approved product facts to copy generation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-0000-0000-000000000101", user_id: "u1", name: "边缘算力",
        positioning: "快速部署", core_values: ["部署简单"], verifiable_facts: [{ statement: "已确认事实" }],
        current_benefits: [], common_objections: [], prohibited_expressions: ["绝对领先"], version: 2,
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) return { rows: [{
        id: "00000000-0000-0000-0000-000000000102", segment_id: null,
        audience_description: "华东制造业管理者", criteria: {}, profile_ids: [], excluded_profile_ids: [],
        metrics: { totalProfiles: 0, warnings: [] }, sampled_at: new Date(), created_at: new Date(),
      }] };
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [{ tone: ["专业克制"], standard_calls_to_action: ["预约咨询"], version: 1 }] };
      if (sql.includes("FROM de_marketing_asset_library asset")) return { rows: [{
        id: "00000000-0000-0000-0000-000000000103", campaign_id: "00000000-0000-0000-0000-000000000104",
        campaign_name: "测试活动", segment_snapshot_id: "00000000-0000-0000-0000-000000000102", segment_name: null,
        asset_type: "text", title: "部署简单", content: "面向制造业管理者的已确认营销文案。", source: "workspace",
        model_id: "m1", task_id: null, generation_status: "ready", status: "ready", version: 1,
        deployments: [], created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const createCopy = vi.fn(async ({ brief }) => {
      expect(JSON.stringify(brief)).not.toContain("李静");
      expect(brief).toMatchObject({
        audience: { description: "华东制造业管理者", metrics: { totalProfiles: 0 } },
        product: { name: "边缘算力", verifiableFacts: [{ statement: "已确认事实" }] },
      });
      return { title: "部署简单", content: "面向制造业管理者的已确认营销文案。", modelId: "m1" };
    });
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      undefined,
      { createCopy, recommend: vi.fn() },
    );

    const result = await service.createAsset("u1", {
      assetType: "copy", prompt: "强调部署简单", publicAudience: "华东制造业管理者",
      productId: "00000000-0000-0000-0000-000000000101", objective: "获得咨询",
      channels: ["朋友圈"], callToAction: "预约咨询",
    });

    expect(createCopy).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ assetType: "text", generationStatus: "ready" });
    expect(query.mock.calls.some((call) => String(call[0]).includes("de_copy_projects"))).toBe(false);
  });

  it("never exposes individual member names to recommendation generation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("de_customer_cohort_snapshots")) return { rows: [{ snapshot_date: "2026-08-20", summary: "聚合总结", metrics: { totalProfiles: 5 }, generated_at: new Date(), generation_method: "logic", model_id: null }] };
      if (sql.includes("FROM de_customer_segments segment")) return { rows: [{ id: "s1", name: "制造业潜客", description: "聚合客群", criteria: {}, status: "active", created_at: new Date(), updated_at: new Date(), snapshot_id: "ss1", snapshot_metrics: { totalProfiles: 5 }, snapshot_sampled_at: new Date() }] };
      if (sql.includes("FROM marketing_products WHERE user_id")) return { rows: [{ id: "p1", name: "产品A", positioning: "定位", core_values: ["价值"], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [], version: 1 }] };
      if (sql.includes("marketing_brand_assets")) return { rows: [] };
      if (sql.includes("SELECT recommendation.*")) return { rows: [] };
      return { rows: [] };
    });
    const recommend = vi.fn(async (input) => {
      expect(JSON.stringify(input)).not.toContain("李静");
      expect(input.segments[0]).toEqual(expect.objectContaining({ name: "制造业潜客", metrics: { totalProfiles: 5 } }));
      return { recommendations: [], modelId: "m1" };
    });
    const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend, createCopy: vi.fn() });
    await service.refreshRecommendations("u1");
    expect(recommend).toHaveBeenCalledOnce();
  });

  it("evaluates segment-product fit with aggregate metrics only", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_customer_segment_snapshots")) return { rows: [{
        id: "ss1", segment_id: "s1", audience_description: "华东制造业潜客", criteria: {},
        profile_ids: ["secret-profile"], excluded_profile_ids: [],
        metrics: { totalProfiles: 12, commonNeeds: [{ label: "部署简单", count: 8 }], warnings: [] },
        sampled_at: new Date(), created_at: new Date(),
      }] };
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "p1", name: "边缘算力", positioning: "快速部署", core_values: ["部署简单"],
        verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [], version: 1,
      }] };
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      return { rows: [] };
    });
    const evaluateFit = vi.fn(async (input) => {
      expect(JSON.stringify(input)).not.toContain("secret-profile");
      expect(JSON.stringify(input)).not.toContain("李静");
      return {
        title: "部署简单主题", objective: "获得咨询", theme: "3天上线", reasoning: ["共同需求是部署"],
        corePoints: ["部署简单"], suggestedChannels: ["朋友圈"], risks: [], priority: "high" as const, modelId: "m1",
      };
    });
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any, undefined, { recommend: vi.fn(), createCopy: vi.fn(), evaluateFit },
    );
    const result = await service.evaluateSegmentProductFit("u1", {
      segmentSnapshotId: "ss1", productId: "p1",
    });
    expect(evaluateFit).toHaveBeenCalledOnce();
    expect(result.fit.theme).toBe("3天上线");
    expect(result.audience.metrics.totalProfiles).toBe(12);
  });

  it("checks the fixed media model before creating campaign records", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
      }] };
      return { rows: [] };
    });
    const enqueue = vi.fn();
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue } as any,
      undefined,
      { get: vi.fn(async () => ({ image: false, video: true, imageModelId: null, videoModelId: "doubao-seedance-2.0", configurationUrl: "https://tokenhub.example" })) },
    );

    await expect(service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约",
    })).rejects.toThrow("gpt-image-2.0");

    expect(enqueue).not.toHaveBeenCalled();
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_marketing_campaigns"))).toBe(false);
  });

  it("reuses an existing campaign snapshot and brief instead of creating another activity", async () => {
    const campaignId = "00000000-0000-4000-8000-000000000201";
    const snapshotId = "00000000-0000-4000-8000-000000000202";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_marketing_campaigns WHERE id=")) return { rows: [{
        id: campaignId, product_id: "00000000-0000-4000-8000-000000000101",
        segment_snapshot_id: snapshotId, objective: "获得咨询", channels: ["朋友圈"],
        call_to_action: "预约咨询", name: "边缘算力活动",
      }] };
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", user_id: "u1", name: "边缘算力",
        positioning: "快速部署", core_values: ["部署简单"], verifiable_facts: [],
        current_benefits: [], common_objections: [], prohibited_expressions: [], version: 1,
      }] };
      if (sql.includes("FROM de_customer_segment_snapshots WHERE id=")) return { rows: [{
        id: snapshotId, audience_description: "华东制造业管理者", criteria: {}, metrics: { totalProfiles: 9 },
        sampled_at: new Date(), created_at: new Date(),
      }] };
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      if (sql.includes("FROM de_marketing_asset_library asset")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000203", campaign_id: campaignId, campaign_name: "边缘算力活动",
        segment_snapshot_id: snapshotId, asset_type: "poster", title: "海报", content: "", source: "workspace",
        model_id: "m1", task_id: "t1", generation_status: "pending", status: "draft", version: 1,
        deployments: [], created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "t1");
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue } as any,
      { createCopy: vi.fn(), recommend: vi.fn() },
      { get: vi.fn(async () => ({ image: true, video: true, imageModelId: "gpt-image-2.0", videoModelId: "seedance 2.0", configurationUrl: "https://tokenhub.example" })) },
    );

    const result = await service.createAsset("u1", {
      assetType: "poster", prompt: "同一主题海报", campaignId,
      productId: "00000000-0000-4000-8000-000000000101",
      objective: "获得咨询", channels: ["朋友圈"], callToAction: "预约咨询",
    });

    expect(result.campaignId).toBe(campaignId);
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_marketing_campaigns"))).toBe(false);
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_customer_segment_snapshots"))).toBe(false);
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_campaign_briefs"))).toBe(false);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("turns a stored campaign opportunity into a marketing campaign", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM de_campaign_opportunities WHERE id=")) return { rows: [{
        id: "o1", status: "suggested", title: "部署简单主题", objective: "获得咨询",
        product_id: "p1", segment_snapshot_id: "ss1", suggested_channels: ["朋友圈"],
      }] };
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "p1", name: "边缘算力", positioning: "", core_values: [], verifiable_facts: [],
        current_benefits: [], common_objections: [], prohibited_expressions: [], version: 1,
      }] };
      if (sql.includes("FROM de_customer_segment_snapshots WHERE id=")) return { rows: [{
        id: "ss1", audience_description: "制造业潜客", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date(),
      }] };
      if (sql.includes("INSERT INTO de_marketing_campaigns")) return { rows: [] };
      if (sql.includes("FROM de_marketing_campaigns campaign")) return { rows: [{
        id: "c1", name: "部署简单主题", objective: "获得咨询", channels: ["朋友圈"], call_to_action: "了解详情或预约咨询",
        status: "draft", product_id: "p1", product_name: "边缘算力", segment_snapshot_id: "ss1",
        audience_description: "制造业潜客", metrics: {}, opportunity_id: "o1", selected_assets: {},
        asset_count: 0, result_count: 0, created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const service = new CustomerAcquisitionService({ pool: { query } } as any);
    const campaign = await service.acceptCampaignOpportunity("u1", "o1");
    expect(campaign.opportunityId).toBe("o1");
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_marketing_campaigns"))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes("status='accepted'"))).toBe(true);
  });
});
