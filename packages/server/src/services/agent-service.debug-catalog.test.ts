import { describe, it, expect } from "vitest";
import { AgentService, type ServiceConfig } from "./agent-service.js";
import type { ModelCatalogConfig } from "../models/catalog.js";

const modelCatalog: ModelCatalogConfig = {
  providerMap: {},
  defaultProvider: { llm: "openai", image: "openai", video: "openai" },
  pricing: {},
  defaultPricing: {
    llm: { inputPrice: 1, outputPrice: 2, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 3 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 4 },
  },
};

function makeService(debug: boolean): AgentService {
  const config: ServiceConfig = {
    llm: {
      default: "openai",
      openai: { apiKey: "", baseUrl: "http://x", model: "env-model" },
      anthropic: { apiKey: "", model: "claude" },
    } as ServiceConfig["llm"],
    models: [],
    modelCatalog,
    debug,
    managedKeysEnabled: false,
    agent: {},
    mcpConfigPath: "",
    skillsDir: "",
  };
  const service = new AgentService(config);
  // getUserModelCatalog reads this.redis (Redis miss) before the apiKey branch.
  (service as unknown as { redis: { get: () => Promise<null> } }).redis = {
    get: async () => null,
  };
  return service;
}

describe("getUserModelCatalog — debug env catalog", () => {
  it("reorders an existing cached catalog to use the new preferred model immediately", async () => {
    const service = makeService(false);
    const ids = ["claude-opus-4.1", "gpt-5.4", "deepseek-v4.1-flash"];
    (service as unknown as { redis: { get: () => Promise<string> } }).redis = {
      get: async () => JSON.stringify({
        llm: ids.map((id) => ({ id, type: "llm", provider: "openai" })),
        image: [], video: [],
      }),
    };
    const catalog = await service.getUserModelCatalog("u1", "test-user-key");
    expect(catalog!.llm.map((model) => model.id)).toEqual([
      "deepseek-v4.1-flash", "gpt-5.4", "claude-opus-4.1",
    ]);
  });
  it("returns the single env LLM when debug is on and there is no apiKey", async () => {
    const service = makeService(true);
    const catalog = await service.getUserModelCatalog("u1", null);
    expect(catalog).not.toBeNull();
    expect(catalog!.llm.map((m) => m.id)).toEqual(["env-model"]);
    expect(catalog!.llm[0].provider).toBe("openai");
    expect(catalog!.image).toEqual([]);
    expect(catalog!.video).toEqual([]);
  });

  it("returns null when debug is off and there is no apiKey", async () => {
    const service = makeService(false);
    const catalog = await service.getUserModelCatalog("u1", null);
    expect(catalog).toBeNull();
  });
});
