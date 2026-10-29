import { afterEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createModelRoutes } from "./models.js";
import { AgentService } from "../services/agent-service.js";

afterEach(() => vi.unstubAllEnvs());

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
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createModelRoutes(service));
  return app;
}

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

  it("normalizes a pre-change cached catalog so server-side defaults are Claude-last", async () => {
    const cached = JSON.stringify({
      llm: [{ id: "claude-sonnet-4", type: "llm", provider: "openai" }, { id: "gpt-5.4", type: "llm", provider: "openai" }],
      image: [],
      video: [],
    });
    const service = svc(cached);
    const res = await mount(service).request("/");
    expect((await res.json() as any).llm.map((model: { id: string }) => model.id)).toEqual(["gpt-5.4", "claude-sonnet-4"]);
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
