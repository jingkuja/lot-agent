import { describe, it, expect } from "vitest";
import { catalogModelConfig } from "../services/agent-service.js";
import type { ModelCatalogConfig } from "../models/catalog.js";

const cfg: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
  providerMap: {}, pricing: {},
  defaultPricing: {
    llm: { inputPrice: 0.001, outputPrice: 0.002, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
  },
};

describe("catalogModelConfig", () => {
  it("builds a ModelConfig for an unknown llm id using default pricing", () => {
    const mc = catalogModelConfig(cfg, "brand-new-llm", "llm");
    expect(mc).toMatchObject({ id: "brand-new-llm", type: "llm", inputPrice: 0.001, outputPrice: 0.002 });
  });
});
