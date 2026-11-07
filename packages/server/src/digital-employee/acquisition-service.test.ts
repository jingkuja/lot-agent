import { describe, expect, it, vi } from "vitest";
import { GenerationFailedError } from "./errors.js";
import { CustomerAcquisitionService, campaignMediaPrompt, campaignVideoModels, fallbackCopy, selectPosterReferences, fallbackRecommendations } from "./acquisition-service.js";
import type { CampaignModelAvailability } from "./acquisition-types.js";

function availability(overrides: Partial<CampaignModelAvailability> = {}): CampaignModelAvailability {
  const llmModels = overrides.llmModels
    ?? (overrides.llm === false ? [] : [{ id: overrides.llmModelId ?? "gpt-5.4" }]);
  const imageModels = overrides.imageModels
    ?? (overrides.image === false ? [] : [{ id: overrides.imageModelId ?? "gpt-image-2.0" }]);
  const videoModels = overrides.videoModels
    ?? (overrides.video === false ? [] : [{ id: overrides.videoModelId ?? "seedance 2.0" }]);
  return {
    configurationUrl: "https://tokenhub.example",
    ...overrides,
    llmModels,
    imageModels,
    videoModels,
    llm: llmModels.length > 0,
    image: imageModels.length > 0,
    video: videoModels.length > 0,
    llmModelId: overrides.llmModelId !== undefined ? overrides.llmModelId : llmModels[0]?.id ?? null,
    imageModelId: overrides.imageModelId !== undefined ? overrides.imageModelId : imageModels[0]?.id ?? null,
    videoModelId: overrides.videoModelId !== undefined ? overrides.videoModelId : videoModels[0]?.id ?? null,
  };
}

describe("CustomerAcquisitionService", () => {
  describe("a failed model call", () => {
    const groupQuery = () => vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE user_id")) {
        return { rows: [{ id: "p1", name: "产品A", positioning: "定位", core_values: [], verifiable_facts: [], common_objections: [] }] };
      }
      return { rows: [] };
    });

    it.each([
      ["throws", async () => { throw new Error("upstream"); }],
      ["returns nothing usable", async () => ({ recommendations: [], modelId: "m" })],
    ])("fails the campaign ideas when the model %s", async (_label, recommend) => {
      const query = groupQuery();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend, createCopy: vi.fn() });
      await expect(service.refreshRecommendations("u1")).rejects.toBeInstanceOf(GenerationFailedError);
      expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO de_daily_recommendations"))).toBe(false);
      warn.mockRestore();
    });

    it("leaves the free rule scan alone", async () => {
      const query = groupQuery();
      const recommend = vi.fn();
      const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend, createCopy: vi.fn() });
      await service.refreshRecommendations("u1", undefined, { rulesOnly: true });
      expect(recommend).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO de_daily_recommendations"))).toBe(true);
    });

    const productQuery = () => vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{ id: "p1", name: "Product", version: 1 }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) return { rows: [{
        id: "s1", audience_description: "Public", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date(),
      }] };
      return { rows: [] };
    });
    const input = {
      assetType: "copy" as const, prompt: "write", publicAudience: "Public", productId: "p1", objective: "Inform", channels: ["web"], callToAction: "Read",
    };
    const wrote = (query: ReturnType<typeof productQuery>, table: string) => query.mock.calls.some(([sql]) => sql.includes(`INSERT INTO ${table}`));

    it("fails the copy and saves nothing, not even an empty campaign", async () => {
      const query = productQuery();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const createCopy = vi.fn(async () => { throw new Error("upstream timeout"); });
      const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend: vi.fn(), createCopy });
      const failure = await service.createAsset("u1", input).catch((error) => error);
      expect(failure).toBeInstanceOf(GenerationFailedError);
      expect(failure.message).toBe("文案生成失败，可以重试");
      expect(createCopy).toHaveBeenCalledOnce();
      for (const table of ["de_marketing_asset_library", "de_campaign_generation_runs", "de_marketing_campaigns"]) expect(wrote(query, table)).toBe(false);
      warn.mockRestore();
    });

    it("keeps the knowledge base's own message", async () => {
      const query = productQuery();
      const createCopy = vi.fn(async () => { throw new GenerationFailedError("所选知识库暂时无法读取，文案没有生成，可以重试"); });
      const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend: vi.fn(), createCopy });
      await expect(service.createAsset("u1", input)).rejects.toThrow("所选知识库");
    });

    it("still swaps the copy when a good reply carries contact details", async () => {
      const query = productQuery();
      const createCopy = vi.fn(async () => ({ title: "t", content: "打 13812345678", modelId: "m" }));
      const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend: vi.fn(), createCopy });
      await service.createAsset("u1", input).catch(() => undefined);
      const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO de_marketing_asset_library"));
      expect(JSON.stringify(insert)).not.toContain("13812345678");
      expect(JSON.stringify(insert)).toContain("contact_replaced");
    });
  });

  it("propagates cancellation through copy generation and never saves its late result or a fallback", async () => {
    const controller = new AbortController();
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{ id: "p1", name: "Product", version: 1 }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) return { rows: [{
        id: "s1", audience_description: "Public", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date(),
      }] };
      return { rows: [] };
    });
    const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, {
      recommend: vi.fn(),
      createCopy: async ({ signal }) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        return { title: "late", content: "late content", modelId: "m" };
      },
    });
    await expect(service.createAsset("u1", {
      assetType: "copy", prompt: "write", publicAudience: "Public", productId: "p1",
      objective: "Inform", channels: ["web"], callToAction: "Read",
    }, controller.signal)).rejects.toThrow();
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO de_marketing_asset_library"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO de_campaign_generation_runs"))).toBe(false);
  });

  it("sends only aggregate audience data and approved product facts to copy generation", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
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
    const query = vi.fn(async (sql: string, _params?: any[]) => {
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
      return {
        recommendations: [{ type: "copy" as const, theme: "主题", targetSegmentDescription: "制造业潜客", corePoints: [], suggestedChannels: [], reasoning: [] }],
        modelId: "m1",
      };
    });
    const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend, createCopy: vi.fn() });
    await service.refreshRecommendations("u1");
    expect(recommend).toHaveBeenCalledOnce();
  });

  it("does not resurrect adopted or ignored recommendations when the same theme conflicts", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("de_customer_cohort_snapshots")) return { rows: [{ snapshot_date: "2026-08-20", summary: "聚合总结", metrics: { totalProfiles: 5 }, generated_at: new Date(), generation_method: "logic", model_id: null }] };
      if (sql.includes("FROM de_customer_segments segment")) return { rows: [] };
      if (sql.includes("FROM marketing_products WHERE user_id")) return { rows: [{ id: "p1", name: "产品A", positioning: "定位", core_values: ["价值"], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [], version: 1 }] };
      if (sql.includes("marketing_brand_assets")) return { rows: [] };
      if (sql.includes("SELECT recommendation.*")) return { rows: [] };
      return { rows: [] };
    });
    const recommend = vi.fn(async () => ({
      recommendations: [{
        type: "copy" as const, theme: "已处理主题", targetSegmentDescription: "制造业潜客",
        corePoints: ["价值"], suggestedChannels: ["朋友圈"], reasoning: ["聚合"],
      }],
      modelId: "m1",
    }));
    const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend, createCopy: vi.fn() });
    await service.refreshRecommendations("u1");

    const upsertSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("ON CONFLICT (user_id,recommendation_date,recommendation_type,theme)")) ?? "";
    expect(upsertSql).toContain("status='pending'");
    expect(upsertSql).toContain("WHERE de_daily_recommendations.status IN ('pending','expired')");
  });

  it("expires leftover pending recommendations that are not in the new batch", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("de_customer_cohort_snapshots")) return { rows: [{ snapshot_date: "2026-08-20", summary: "聚合总结", metrics: { totalProfiles: 5 }, generated_at: new Date(), generation_method: "logic", model_id: null }] };
      if (sql.includes("FROM de_customer_segments segment")) return { rows: [] };
      if (sql.includes("FROM marketing_products WHERE user_id")) return { rows: [{ id: "p1", name: "产品A", positioning: "定位", core_values: ["价值"], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [], version: 1 }] };
      if (sql.includes("marketing_brand_assets")) return { rows: [] };
      if (sql.includes("SELECT recommendation.*")) return { rows: [] };
      return { rows: [] };
    });
    const recommend = vi.fn(async () => ({
      recommendations: [
        { type: "copy" as const, theme: "新主题A", targetSegmentDescription: "制造业潜客", corePoints: ["价值"], suggestedChannels: ["朋友圈"], reasoning: ["聚合"] },
        { type: "poster" as const, theme: "新主题B", targetSegmentDescription: "制造业潜客", corePoints: ["价值"], suggestedChannels: ["朋友圈"], reasoning: ["聚合"] },
      ],
      modelId: "m1",
    }));
    const service = new CustomerAcquisitionService({ pool: { query } } as any, undefined, { recommend, createCopy: vi.fn() });
    await service.refreshRecommendations("u1");

    const expireCall = query.mock.calls.find((call) => {
      const sql = String(call[0]);
      return sql.includes("SET status='expired'") && sql.includes("unnest");
    });
    expect(expireCall).toBeTruthy();
    expect(String(expireCall?.[0])).toContain("AND status='pending'");
    expect(String(expireCall?.[0])).toContain("(recommendation_type, theme) IN");
    expect(expireCall?.[1]?.[2]).toEqual(["copy", "poster"]);
    expect(expireCall?.[1]?.[3]).toEqual(["新主题A", "新主题B"]);
  });

  it("evaluates segment-product fit with aggregate metrics only", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
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

  it("returns an empty catalog and TokenHub URL when no resolver is configured", async () => {
    const service = new CustomerAcquisitionService({ pool: { query: vi.fn() } } as any);
    await expect(service.getModelAvailability("u1")).resolves.toMatchObject({
      llm: false,
      image: false,
      video: false,
      llmModels: [],
      imageModels: [],
      videoModels: [],
      configurationUrl: "https://wetok.ai/",
    });
  });

  it("blocks media generation when no image models are available", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
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
      { get: vi.fn(async () => availability({ image: false, video: true, imageModelId: null, videoModelId: "doubao-seedance-2.0" })) },
    );

    await expect(service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约",
    })).rejects.toThrow("图像模型");

    expect(enqueue).not.toHaveBeenCalled();
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_marketing_campaigns"))).toBe(false);
  });

  it("uses the requested image model when it is in the user's catalog", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
        positioning: "", core_values: [], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [],
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) {
        return { rows: [{ id: "ss1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date() }] };
      }
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      if (sql.includes("FROM de_marketing_asset_library asset")) return { rows: [{
        id: "a1", campaign_id: "c1", asset_type: "poster", title: "海报", content: "", source: "workspace",
        generation_status: "pending", status: "draft", version: 1, deployments: [], created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-1");
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue, cancel: vi.fn() } as any,
      undefined,
      { get: vi.fn(async () => availability({
        imageModels: [{ id: "gpt-image-2.0" }, { id: "flux-pro" }],
        videoModels: [{ id: "seedance 2.0" }],
      })) },
    );
    await service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约", modelId: "flux-pro",
    });
    expect(enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ modelId: "flux-pro" }),
      "u1",
    );
  });

  it("adds the owner's logo and store photo to the poster, skipping files they no longer own", async () => {
    const logo = "/static/uploads/logo.png";
    const photo = "/static/uploads/store.jpg";
    const foreign = "/static/uploads/other.jpg";
    const dish = "/static/uploads/dish.jpg";
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
        positioning: "", core_values: [], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [],
        images: [{ name: "招牌牛肉面", url: dish }, { name: "别人的", url: foreign }],
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) {
        return { rows: [{ id: "ss1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date() }] };
      }
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [{ business_name: "小王面馆", version: 1, visual_assets: [
        { name: "别人的", url: foreign, type: "store" },
        { name: "门头", url: photo, type: "store" },
        { name: "logo", url: logo, type: "Logo" },
        { name: "品牌手册", url: "https://example.com/guide.pdf" },
      ] }] };
      if (sql.includes("FROM assets")) return { rows: [{ url: logo }, { url: photo }, { url: dish }] };
      if (sql.includes("FROM de_marketing_asset_library asset")) return { rows: [{
        id: "a1", campaign_id: "c1", asset_type: "poster", title: "海报", content: "", source: "workspace",
        generation_status: "pending", status: "draft", version: 1, deployments: [], created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-1");
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue, cancel: vi.fn() } as any,
      undefined,
      { get: vi.fn(async () => availability({ imageModels: [{ id: "flux-pro" }], videoModels: [{ id: "seedance 2.0" }] })) },
    );
    await service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "周边居民",
      productId: "00000000-0000-4000-8000-000000000101", objective: "到店",
      channels: ["朋友圈"], callToAction: "到店", modelId: "flux-pro",
    });
    const payload = (enqueue.mock.calls[0] as unknown[])[1] as { media: unknown; prompt: string };
    expect(payload.media).toEqual([
      { type: "reference_image", url: logo }, { type: "reference_image", url: dish }, { type: "reference_image", url: photo },
    ]);
    expect(payload.prompt).toContain("Reference image 2 shows the real product");
    expect(payload.prompt).toContain("Business name: 小王面馆");
    expect(payload.prompt).toContain("The first reference image is the business logo");
    const lookup = query.mock.calls.find((call) => String(call[0]).includes("FROM assets"));
    expect(lookup?.[1]?.[0]).toBe("u1");
  });

  it("forwards image settings and reference images into the generation job", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
        positioning: "", core_values: [], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [],
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) {
        return { rows: [{ id: "ss1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date() }] };
      }
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      if (sql.includes("FROM de_marketing_asset_library asset")) return { rows: [{
        id: "a1", campaign_id: "c1", asset_type: "poster", title: "海报", content: "", source: "workspace",
        generation_status: "pending", status: "draft", version: 1, deployments: [], created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-2");
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue, cancel: vi.fn() } as any,
      undefined,
      { get: vi.fn(async () => availability()) },
    );
    await service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约",
      mediaSettings: { size: "1536x1024", n: 1, quality: "high" },
      attachments: [{
        assetId: "att1", filename: "ref.png", mime: "image/png", size: 12,
        url: "/static/uploads/ref.png", kind: "image",
      }],
    });
    expect(enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({
        size: "1536x1024",
        quality: "high",
        media: [{ type: "reference_image", url: "/static/uploads/ref.png" }],
      }),
      "u1",
    );
  });

  it("passes knowledge bases and attachments into copy generation", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", user_id: "u1", name: "边缘算力",
        positioning: "快速部署", core_values: ["部署简单"], verifiable_facts: [],
        current_benefits: [], common_objections: [], prohibited_expressions: [], version: 1,
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000102", audience_description: "华东制造业管理者",
        criteria: {}, metrics: { totalProfiles: 0, warnings: [] }, sampled_at: new Date(), created_at: new Date(),
      }] };
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      if (sql.includes("FROM de_marketing_asset_library asset")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000103", campaign_id: "c1", asset_type: "text", title: "文案",
        content: "正文", source: "workspace", model_id: "m1", generation_status: "ready", status: "ready",
        version: 1, deployments: [], created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const createCopy = vi.fn(async () => ({ title: "文案", content: "正文", modelId: "m1" }));
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      undefined,
      { createCopy, recommend: vi.fn() },
      { get: vi.fn(async () => availability({ llmModels: [{ id: "gpt-5.4" }, { id: "claude-sonnet" }] })) },
    );
    await service.createAsset("u1", {
      assetType: "copy", prompt: "强调部署简单", publicAudience: "华东制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "获得咨询",
      channels: ["朋友圈"], callToAction: "预约咨询",
      modelId: "claude-sonnet",
      knowledgeBaseIds: ["kb-1"],
      attachments: [{
        assetId: "att1", filename: "note.txt", mime: "text/plain", size: 8,
        url: "/static/uploads/note.txt", kind: "doc",
      }],
    });
    expect(createCopy).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "claude-sonnet",
      knowledgeBaseIds: ["kb-1"],
      attachments: [expect.objectContaining({ filename: "note.txt" })],
    }));
  });

  it("blocks copy generation before creating an activity when no LLM models are available", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
      }] };
      return { rows: [] };
    });
    const createCopy = vi.fn();
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      undefined,
      { createCopy, recommend: vi.fn() },
      { get: vi.fn(async () => availability({ llm: false, llmModelId: null, llmModels: [] })) },
    );

    await expect(service.createAsset("u1", {
      assetType: "copy", prompt: "生成文案", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约",
    })).rejects.toThrow("LLM模型");

    expect(createCopy).not.toHaveBeenCalled();
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_marketing_campaigns"))).toBe(false);
  });

  it("rejects a media model that is not in the user's catalog", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
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
      { get: vi.fn(async () => availability()) },
    );
    await expect(service.createAsset("u1", {
      assetType: "video", prompt: "生成视频", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约", modelId: "unknown-video",
    })).rejects.toThrow("所选视频模型不可用");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reuses an existing campaign snapshot and brief instead of creating another activity", async () => {
    const campaignId = "00000000-0000-4000-8000-000000000201";
    const snapshotId = "00000000-0000-4000-8000-000000000202";
    const query = vi.fn(async (sql: string, _params?: any[]) => {
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
      { get: vi.fn(async () => availability()) },
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
    const insertAt = query.mock.calls.findIndex((call) => String(call[0]).includes("INSERT INTO de_marketing_asset_library"));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(String(query.mock.calls[insertAt]?.[0])).not.toContain("task_id");
  });

  it("does not enqueue a media job before the asset row is persisted", async () => {
    const events: string[] = [];
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
        positioning: "", core_values: [], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [],
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) {
        return { rows: [{ id: "ss1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date() }] };
      }
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      if (sql.includes("INSERT INTO de_marketing_asset_library")) { events.push("insert-asset"); return { rows: [] }; }
      if (sql.includes("UPDATE de_marketing_asset_library SET task_id")) { events.push("link-task"); return { rows: [] }; }
      if (sql.includes("FROM de_marketing_asset_library asset")) return { rows: [{
        id: "a1", campaign_id: "c1", asset_type: "poster", title: "海报", content: "", source: "workspace",
        generation_status: "pending", status: "draft", version: 1, deployments: [], created_at: new Date(), updated_at: new Date(),
      }] };
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => { events.push("enqueue"); return "task-1"; });
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue, cancel: vi.fn() } as any,
      undefined,
      { get: vi.fn(async () => availability({ configurationUrl: "https://x" })) },
    );
    await service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约",
    });
    expect(events.indexOf("insert-asset")).toBeLessThan(events.indexOf("enqueue"));
    expect(events.indexOf("enqueue")).toBeLessThan(events.indexOf("link-task"));
  });

  it("does not enqueue when persisting the media asset fails", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
        positioning: "", core_values: [], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [],
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) {
        return { rows: [{ id: "ss1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date() }] };
      }
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      if (sql.includes("INSERT INTO de_marketing_asset_library")) throw new Error("db down");
      return { rows: [] };
    });
    const enqueue = vi.fn();
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue } as any,
      undefined,
      { get: vi.fn(async () => availability({ configurationUrl: "https://x" })) },
    );
    await expect(service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约",
    })).rejects.toThrow("db down");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("cancels the queued job if linking the task id fails", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("FROM marketing_products WHERE id=")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000101", name: "产品A", version: 1,
        positioning: "", core_values: [], verifiable_facts: [], current_benefits: [], common_objections: [], prohibited_expressions: [],
      }] };
      if (sql.includes("INSERT INTO de_customer_segment_snapshots")) {
        return { rows: [{ id: "ss1", audience_description: "公开受众", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date() }] };
      }
      if (sql.includes("FROM marketing_brand_assets")) return { rows: [] };
      if (sql.includes("UPDATE de_marketing_asset_library SET task_id")) throw new Error("link failed");
      return { rows: [] };
    });
    const enqueue = vi.fn(async () => "task-9");
    const cancel = vi.fn(async () => true);
    const service = new CustomerAcquisitionService(
      { pool: { query } } as any,
      { enqueue, cancel } as any,
      undefined,
      { get: vi.fn(async () => availability({ configurationUrl: "https://x" })) },
    );
    await expect(service.createAsset("u1", {
      assetType: "poster", prompt: "生成海报", publicAudience: "制造业管理者",
      productId: "00000000-0000-4000-8000-000000000101", objective: "咨询",
      channels: ["朋友圈"], callToAction: "预约",
    })).rejects.toThrow("link failed");
    expect(cancel).toHaveBeenCalledWith("task-9");
    expect(query.mock.calls.some((call) => String(call[0]).includes("generation_status='failed'"))).toBe(true);
  });

  it("turns a stored campaign opportunity into a marketing campaign", async () => {
    const query = vi.fn(async (sql: string, _params?: any[]) => {
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

  it("creates nothing from an opportunity until its draft is committed", async () => {
    const opportunity = {
      id: "o1", status: "suggested", title: "部署简单主题", objective: "获得咨询", product_id: "p1",
      suggested_channels: ["朋友圈"], segment_snapshot_id: "ss1",
    };
    const query = vi.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM de_campaign_opportunities")) return { rows: [opportunity] };
      if (sql.includes("FROM de_customer_segment_snapshots")) return { rows: [{
        id: "ss1", audience_description: "制造业潜客", criteria: {}, metrics: {}, sampled_at: new Date(), created_at: new Date(),
      }] };
      if (sql.includes("SELECT id,name FROM marketing_products")) return { rows: [{ id: "p1", name: "边缘算力" }] };
      if (sql.includes("INSERT INTO de_conversation_action_drafts")) return { rows: [{
        id: params![0], user_id: "u1", feature_scope: params![4], kind: params![5], payload: JSON.parse(params![6]), preview: {},
        options: [], status: "awaiting_confirmation", created_at: new Date(), expires_at: params![11],
      }] };
      return { rows: [] };
    });
    const service = new CustomerAcquisitionService({ pool: { query } } as any);
    const draft = await service.prepareCampaignOpportunity("u1", "o1", {});
    expect(draft.kind).toBe("marketing_campaign");
    expect(draft.payload).toMatchObject({ opportunityId: "o1", segmentSnapshotId: "ss1" });
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO de_marketing_campaigns"))).toBe(false);
    expect(query.mock.calls.some((call) => String(call[0]).includes("status='accepted'"))).toBe(false);
  });

  it("refuses to prepare an opportunity that was already handled", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "o1", status: "dismissed", product_id: "p1" }] }));
    const service = new CustomerAcquisitionService({ pool: { query } } as any);
    await expect(service.prepareCampaignOpportunity("u1", "o1", {})).rejects.toThrow("已经处理");
  });

  it("commits an opportunity draft through acceptance, so its status moves too", async () => {
    const service = new CustomerAcquisitionService({ pool: { query: vi.fn(async () => ({ rows: [{ id: "d1" }] })) } } as any);
    vi.spyOn((service as any).drafts, "get").mockResolvedValue({ status: "awaiting_confirmation", payload: { opportunityId: "o1", name: "主题" } });
    const markApplied = vi.spyOn((service as any).drafts, "markApplied").mockResolvedValue(undefined);
    const accept = vi.spyOn(service, "acceptCampaignOpportunity").mockResolvedValue({ id: "c1" } as never);
    const create = vi.spyOn(service, "createMarketingCampaign");
    await service.commitMarketingCampaign("u1", "d1");
    expect(accept).toHaveBeenCalledWith("u1", "o1");
    expect(create).not.toHaveBeenCalled();
    expect(markApplied).toHaveBeenCalledWith("u1", "d1", "c1");
  });
});


describe("acquisition prompt quality helpers", () => {
  const product = {
    name: "边缘算力",
    positioning: "快速部署",
    core_values: ["部署简单", "成本可控"],
    verifiable_facts: [{ statement: "已服务 30 家工厂" }],
    current_benefits: [{ title: "首月试用" }],
    faqs: [{ question: "多久上线？", answer: "两周内" }],
    product_notes: "适合华东制造产线改造",
    prohibited_expressions: ["绝对领先"],
  };

  it("builds richer fallback copy with facts and FAQ", () => {
    const copy = fallbackCopy(
      { title: "部署海报文案", prompt: "强调部署效率", callToAction: "预约演示", objective: "获咨询", channels: ["朋友圈"], assetType: "copy", productId: "p1" } as any,
      { audienceDescription: "华东制造业管理者" },
      product,
    );
    expect(copy).toContain("华东制造业管理者");
    expect(copy).toContain("已服务 30 家工厂");
    expect(copy).toContain("多久上线？");
    expect(copy).toContain("预约演示");
  });

  it("includes layout and resolution guidance in poster prompts", () => {
    const prompt = campaignMediaPrompt(
      { prompt: "突出部署简单", objective: "获咨询", callToAction: "预约演示", channels: ["朋友圈"], assetType: "poster", productId: "p1", mediaSettings: { size: "1536x1024", quality: "high" } } as any,
      { audienceDescription: "华东制造业管理者" },
      product,
      { tone: ["专业克制"], visual_assets: [{ name: "主色蓝" }] },
      "poster",
    );
    expect(prompt).toContain("1536x1024");
    expect(prompt).toContain("print-quality clarity");
    expect(prompt).toContain("多久上线？");
    expect(prompt).toContain("适合华东制造产线改造");
  });

  it("names the business and its reference images in poster prompts", () => {
    const prompt = campaignMediaPrompt(
      { prompt: "开业海报", objective: "到店", callToAction: "到店品尝", channels: ["朋友圈"], assetType: "poster", productId: "p1" } as any,
      { audienceDescription: "周边居民" },
      product,
      { business_name: "小王面馆", business_intro: "开了十年的牛肉面馆", visual_assets: [
        { name: "IMG_1.png", url: "/static/uploads/a.png", type: "logo" }, { name: "主色蓝" },
      ] },
      "poster",
      { urls: ["/static/uploads/a.png", "/static/uploads/p.png", "/static/uploads/b.png"], hasLogo: true, productImages: 1, storePhotos: 1 },
    );
    expect(prompt).toContain("Business name: 小王面馆");
    expect(prompt).toContain("About the business: 开了十年的牛肉面馆");
    expect(prompt).toContain("The first reference image is the business logo");
    expect(prompt).toContain("Reference image 2 shows the real product");
    expect(prompt).toContain("The last 1 reference image(s) are real photos");
    expect(prompt).toContain("Visual references: 主色蓝");
    expect(prompt).not.toContain("IMG_1.png");
  });

  it("orders poster references as logo, attached, product, store photos within five", () => {
    expect(selectPosterReferences(["u1"], "logo", ["p1"], ["s1", "s2", "s3"])).toEqual({
      urls: ["logo", "u1", "p1", "s1", "s2"], hasLogo: true, productImages: 1, storePhotos: 2,
    });
    expect(selectPosterReferences([], "logo", ["p1", "p2", "p3"], ["s1", "s2"])).toEqual({
      urls: ["logo", "p1", "p2", "p3", "s1"], hasLogo: true, productImages: 3, storePhotos: 1,
    });
    expect(selectPosterReferences(["1", "2", "3", "4", "5", "6"], "logo", ["p1"], ["s1"])).toEqual({
      urls: ["logo", "1", "2", "3", "4"], hasLogo: true, productImages: 0, storePhotos: 0,
    });
    expect(selectPosterReferences(["1", "2", "3", "4", "5", "6"], null, [], [])).toEqual({
      urls: ["1", "2", "3", "4", "5"], hasLogo: false, productImages: 0, storePhotos: 0,
    });
    expect(selectPosterReferences(["logo", "p1"], "logo", ["p1", "logo"], ["logo"])).toEqual({
      urls: ["logo", "p1"], hasLogo: true, productImages: 0, storePhotos: 0,
    });
  });

  it("surfaces FAQ hooks in fallback recommendations", () => {
    const drafts = fallbackRecommendations(
      [{ id: "s1", name: "制造业潜客" }],
      [{ id: "p1", name: "边缘算力", coreValues: ["部署简单"], faqs: [{ question: "多久上线？", answer: "两周内" }] }],
    );
    expect(drafts.some((item) => item.type === "poster" && item.creativeDirection?.includes("High-resolution"))).toBe(true);
    expect(drafts[0].reasoning?.some((line) => line.includes("多久上线"))).toBe(true);
  });
});

describe("deployment feedback idempotency", () => {
  it("returns the original feedback when the same request id is retried", async () => {
    const deploymentId = "00000000-0000-4000-8000-000000000201";
    const requestId = "00000000-0000-4000-8000-000000000301";
    const original = {
      id: "00000000-0000-4000-8000-000000000401", deployment_id: deploymentId, impressions: 50,
      interactions: null, conversions: null, feedback_text: "", recorded_at: "2026-10-18T00:00:00Z",
    };
    const query = vi.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes("SELECT id FROM de_asset_deployments")) return { rows: [{ id: deploymentId }] };
      if (sql.includes("INSERT INTO de_deployment_feedback")) return { rows: [] };
      if (sql.includes("FROM de_deployment_feedback WHERE")) return { rows: [original] };
      return { rows: [] };
    });
    const service = new CustomerAcquisitionService({ pool: { query } } as any);
    await expect(service.addFeedback("u1", deploymentId, { requestId, impressions: 50 })).resolves.toMatchObject({
      id: original.id, impressions: 50,
    });
    const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO de_deployment_feedback"));
    expect(insert?.[0]).toContain("ON CONFLICT (user_id,deployment_id,request_id)");
    expect((insert as unknown as [string, unknown[]])[1].at(-1)).toBe(requestId);
  });

  it("uses the draft id as the request id when committing agent feedback", async () => {
    const deploymentId = "00000000-0000-4000-8000-000000000201";
    const draftId = "00000000-0000-4000-8000-000000000501";
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id FROM de_asset_deployments")) return { rows: [{ id: deploymentId }] };
      if (sql.includes("INSERT INTO de_deployment_feedback")) return { rows: [{
        id: "f1", deployment_id: deploymentId, impressions: params?.[3], interactions: null, conversions: null,
        feedback_text: "", recorded_at: "2026-10-18T00:00:00Z",
      }] };
      return { rows: [] };
    });
    const service = new CustomerAcquisitionService({ pool: { query } } as any);
    const drafts = {
      markApplied: vi.fn(async () => undefined),
      commit: vi.fn(async (_userId, _id, _kind, handlers) => handlers.apply({ payload: { deploymentId, impressions: 20 } })),
    };
    (service as any).drafts = drafts;
    await service.commitDeploymentFeedback("u1", draftId);
    const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO de_deployment_feedback")) as unknown as [string, unknown[]];
    expect(insert[1].at(-1)).toBe(draftId);
    expect(drafts.markApplied).toHaveBeenCalledWith("u1", draftId, "f1");
  });
});

describe("campaignVideoModels", () => {
  it("hides Grok video from Acquisition model choices", () => {
    expect(campaignVideoModels([{ id: "doubao-seedance-2-5" }, { id: "grok-imagine-video-1.5" }, { id: "kling-video-v3-omni" }]))
      .toEqual([{ id: "doubao-seedance-2-5", label: "doubao-seedance-2-5" }, { id: "kling-video-v3-omni", label: "kling-video-v3-omni" }]);
  });
});
