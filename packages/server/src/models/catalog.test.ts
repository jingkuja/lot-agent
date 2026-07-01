import { describe, it, expect } from "vitest";
import { resolveProvider, resolvePricing, enrichCatalog, type ModelCatalogConfig } from "./catalog.js";

const cfg: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
  providerMap: { "veo3.1": "happyhorse", "gpt-image-2-token": "chat-completions" },
  pricing: { "gpt-image-2-token": { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 } },
  defaultPricing: {
    llm: { inputPrice: 0.001, outputPrice: 0.002, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
  },
};

describe("catalog resolvers", () => {
  it("llm always resolves to the llm default provider", () => {
    expect(resolveProvider(cfg, "any-unknown-llm", "llm")).toBe("openai");
  });
  it("image/video use providerMap then per-type default", () => {
    expect(resolveProvider(cfg, "veo3.1", "video")).toBe("happyhorse");
    expect(resolveProvider(cfg, "unknown-image", "image")).toBe("chat-completions");
  });
  it("pricing uses the table then falls back to per-type default", () => {
    expect(resolvePricing(cfg, "gpt-image-2-token", "image").unitPrice).toBe(0.04);
    expect(resolvePricing(cfg, "brand-new-llm", "llm")).toEqual(cfg.defaultPricing.llm);
  });
  it("enrichCatalog builds three typed buckets", () => {
    const out = enrichCatalog(cfg, { llm: ["gpt-5.4"], image: ["gpt-image-2-token"], video: ["veo3.1"] });
    expect(out.llm[0]).toEqual({ id: "gpt-5.4", type: "llm", provider: "openai", pricing: cfg.defaultPricing.llm });
    expect(out.video[0].provider).toBe("happyhorse");
  });
});
