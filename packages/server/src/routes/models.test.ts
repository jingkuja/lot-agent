import { afterEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createModelRoutes } from "./models.js";
import { AgentService } from "../services/agent-service.js";
import { TokenhubClientError } from "../tokenhub/client.js";

afterEach(() => vi.unstubAllEnvs());

function svc(cacheHit: string | null) {
  return {
    redis: { get: vi.fn().mockResolvedValue(cacheHit), set: vi.fn() },
    db: { getUserApiKey: vi.fn().mockResolvedValue("sk-user") },
    tokenhub: { listModels: vi.fn().mockResolvedValue({ llm: ["gpt-5.4"], image: [], video: ["wan2.2-s2v", "wan2.2-animate-mix", "veo3.1", "VideoRetalk"] }) },
    modelCatalog: {
      defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
      providerMap: {}, pricing: {},
      defaultPricing: {
        llm: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
        image: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
        video: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
      },
    },
    getUserModelCatalog: AgentService.prototype.getUserModelCatalog,
  } as unknown as import("../services/agent-service.js").AgentService;
}

function mount(service: import("../services/agent-service.js").AgentService) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createModelRoutes(service));
  return app;
}

describe("POST /api/models/estimate", () => {
  const body = { model: "gpt-5.4", input_tokens: 1000, output_tokens: 200 };
  const submit = (service: AgentService, data: unknown = body) => mount(service).request("/estimate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });

  it("uses the logged-in user's model key and returns the gateway's points estimate", async () => {
    const service = svc(null);
    const quote = { model: body.model, pricingScheme: "ratio", estimatedQuota: 550, estimatedPoints: 0.11 };
    service.tokenhub.estimateModelCost = vi.fn().mockResolvedValue(quote);

    const res = await submit(service, { ...body, apiKey: "untrusted-key" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(quote);
    expect(service.db.getUserApiKey).toHaveBeenCalledWith("u1", service.managedKeysEnabled);
    expect(service.tokenhub.estimateModelCost).toHaveBeenCalledWith("sk-user", body, expect.any(AbortSignal));
  });

  it("rejects an empty request and preserves gateway model access errors", async () => {
    const service = svc(null);
    service.tokenhub.estimateModelCost = vi.fn().mockRejectedValue(new TokenhubClientError("private detail", undefined, undefined, 403));
    expect((await submit(service, null)).status).toBe(400);
    expect(service.tokenhub.estimateModelCost).not.toHaveBeenCalled();

    const res = await submit(service);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Model access denied", code: "model_access_denied" });
  });

  it.each([
    ["other-video", "720", 120],
    ["other-video", "2K", 150],
    ["other-video", "2160x3840", 200],
  ])("keeps the local estimate for %s at %s when the channel has no token formula", async (model, resolution, rate) => {
    const service = svc(null);
    vi.mocked(service.tokenhub.listModels).mockResolvedValue({
      llm: [], image: [], video: [model], video_token_models: [model],
    });
    service.tokenhub.estimateModelCost = vi.fn();
    const res = await submit(service, { model, video: { resolution, seconds: 5 } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model, pricingScheme: "video_token", estimatedPoints: rate * 5, estimatedQuota: null });
    expect(service.tokenhub.listModels).toHaveBeenCalledWith("sk-user", expect.any(AbortSignal));
    expect(service.tokenhub.estimateModelCost).not.toHaveBeenCalled();
  });

  it.each([
    ["doubao-seedance-2-0", "480p", 864 * 496],
    ["doubao-seedance-2.5", "1280x720", 1280 * 720],
    ["doubao-seedance-2-5", "1080p", 1920 * 1080],
    ["doubao-seedance-2.5", "4K", 3840 * 2160],
  ])("prices %s at %s with the owner's gateway rate and measured input seconds", async (model, resolution, pixels) => {
    const service = svc(null);
    vi.mocked(service.tokenhub.listModels).mockResolvedValue({ llm: [], image: [], video: [model], video_token_models: [model] });
    const quote = { model, pricingScheme: "video_token", estimatedQuota: 55_000, estimatedPoints: 11 };
    service.tokenhub.estimateModelCost = vi.fn().mockResolvedValue(quote);
    const video = { resolution, seconds: 8, has_video_input: true };
    for (const generate_audio of [false, true]) {
      const request_parameters = { ratio: "16:9", reference_video_seconds: 2.5, generate_audio };
      const res = await submit(service, { model, video, request_parameters });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(quote);
      expect(service.tokenhub.estimateModelCost).toHaveBeenLastCalledWith("sk-user", {
        model, video: { ...video, total_tokens: Math.ceil(10.5 * pixels * 24 / 1024) }, request_parameters,
      }, expect.any(AbortSignal));
    }
  });

  it("requires a usable duration and resolution for a token-priced video", async () => {
    const service = svc(null);
    const model = "doubao-seedance-2.5";
    vi.mocked(service.tokenhub.listModels).mockResolvedValue({
      llm: [], image: [], video: [model], video_token_models: [model],
    });
    service.tokenhub.estimateModelCost = vi.fn();
    expect((await submit(service, { model, video: { resolution: "720p", seconds: -1 } })).status).toBe(400);
    expect((await submit(service, { model, video: { resolution: "unknown", seconds: 5 } })).status).toBe(400);
    expect(service.tokenhub.estimateModelCost).not.toHaveBeenCalled();
  });

  it("uses the gateway's estimate for a per-second video", async () => {
    const service = svc(null);
    const model = "grok-imagine-video-1.5";
    const estimate = { model, video: { resolution: "720p", seconds: 5, input_image_count: 2 } };
    const quote = { model, pricingScheme: "video_per_second", estimatedQuota: 550, estimatedPoints: 0.11 };
    vi.mocked(service.tokenhub.listModels).mockResolvedValue({
      llm: [], image: [], video: [model], video_token_models: ["doubao-seedance-2.5"],
    });
    service.tokenhub.estimateModelCost = vi.fn().mockResolvedValue(quote);
    const res = await submit(service, estimate);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(quote);
    expect(service.tokenhub.estimateModelCost).toHaveBeenCalledWith("sk-user", estimate, expect.any(AbortSignal));
  });
});

describe("GET /api/models", () => {
  it.each(["0", "1"])("isolates the catalog cache by deployment mode globle=%s", async globle => {
    vi.stubEnv("globle", globle);
    const fingerprint = createHash("sha256").update("sk-user").digest("hex").slice(0, 16);
    const domestic = `models:u1:${fingerprint}:domestic`;
    const international = `models:u1:${fingerprint}:international`;
    const service = svc(null);
    const cached = JSON.stringify({ llm: [{ id: "international-only" }], image: [], video: [] });
    vi.mocked(service.redis.get).mockImplementation(async key => key === international ? cached : null);
    const res = await mount(service).request("/");
    expect(service.redis.get).toHaveBeenCalledWith(globle === "1" ? international : domestic);
    const body = await res.json() as { llm: Array<{ id: string }> };
    expect(body.llm[0].id).toBe(globle === "1" ? "international-only" : "gpt-5.4");
  });

  it("fetches, enriches, and caches on miss", async () => {
    const service = svc(null);
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.llm[0]).toMatchObject({ id: "gpt-5.4", provider: "openai" });
    expect(body.video).toEqual([expect.objectContaining({ id: "veo3.1", provider: "happyhorse" })]);
    expect(service.redis.set as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("serves cache on hit without calling tokenhub", async () => {
    const cached = JSON.stringify({ llm: [], image: [], video: [] });
    const service = svc(cached);
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    expect(service.tokenhub.listModels).not.toHaveBeenCalled();
  });

  it("applies current ordering and visibility rules to a pre-change cached catalog", async () => {
    const cached = JSON.stringify({
      llm: [{ id: "claude-sonnet-4", type: "llm", provider: "openai" }, { id: "gpt-5.4", type: "llm", provider: "openai" }],
      image: [],
      video: [{ id: "videoretalk" }, { id: "wan2.2-animate-mix" }, { id: "veo3.1" }, { id: "wan2.2-s2v" }],
    });
    const service = svc(cached);
    const res = await mount(service).request("/");
    const body = await res.json() as { llm: { id: string }[]; video: { id: string }[] };
    expect(body.llm.map((model) => model.id)).toEqual(["gpt-5.4", "claude-sonnet-4"]);
    expect(body.video.map((model) => model.id)).toEqual(["veo3.1"]);
    expect(service.tokenhub.listModels).not.toHaveBeenCalled();
  });

  it("does not reuse the legacy user-only cache created by a different key", async () => {
    const cached = JSON.stringify({ llm: [{ id: "old-key-model" }], image: [], video: [] });
    const service = svc(null);
    (service.redis.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) =>
      key === "models:u1" ? cached : null
    );
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    expect((await res.json() as any).llm[0].id).toBe("gpt-5.4");
    expect(service.tokenhub.listModels).toHaveBeenCalledWith("sk-user");
  });

  it("returns an empty catalog (200) when the user has no api key", async () => {
    const service = {
      redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
      db: { getUserApiKey: vi.fn().mockResolvedValue(null) },
      tokenhub: { listModels: vi.fn() },
      getUserModelCatalog: AgentService.prototype.getUserModelCatalog,
      modelCatalog: {} as never,
    } as unknown as import("../services/agent-service.js").AgentService;
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    expect(await res.json() as any).toEqual({ llm: [], image: [], video: [] });
    expect(service.tokenhub.listModels).not.toHaveBeenCalled();
  });
});
