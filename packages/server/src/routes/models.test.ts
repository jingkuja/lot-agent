import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createModelRoutes } from "./models.js";
import { AgentService } from "../services/agent-service.js";

function svc(cacheHit: string | null) {
  return {
    redis: { get: vi.fn().mockResolvedValue(cacheHit), set: vi.fn() },
    db: { getUserApiKey: vi.fn().mockResolvedValue("sk-user") },
    tokenhub: { listModels: vi.fn().mockResolvedValue({ llm: ["gpt-5.4"], image: [], video: ["veo3.1"] }) },
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
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createModelRoutes(service));
  return app;
}

describe("GET /api/models", () => {
  it("fetches, enriches, and caches on miss", async () => {
    const service = svc(null);
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm[0]).toMatchObject({ id: "gpt-5.4", provider: "openai" });
    expect(body.video[0].provider).toBe("happyhorse");
    expect(service.redis.set as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("serves cache on hit without calling tokenhub", async () => {
    const cached = JSON.stringify({ llm: [], image: [], video: [] });
    const service = svc(cached);
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    expect(service.tokenhub.listModels).not.toHaveBeenCalled();
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
    expect(await res.json()).toEqual({ llm: [], image: [], video: [] });
    expect(service.tokenhub.listModels).not.toHaveBeenCalled();
  });
});
