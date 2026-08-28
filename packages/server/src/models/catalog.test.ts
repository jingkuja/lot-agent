import { describe, it, expect } from "vitest";
import { resolveProvider, resolvePricing, enrichCatalog, moveClaudeModelsToEnd, type ModelCatalogConfig } from "./catalog.js";

const cfg: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "openai-video" },
  // the "veo3.1" video entry exists to prove video resolution IGNORES providerMap.
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
  it("video always resolves to the video default, ignoring providerMap", () => {
    // veo3.1 is mapped to happyhorse in providerMap, but video ignores the map —
    // every video model routes through the single defaultProvider.video.
    expect(resolveProvider(cfg, "veo3.1", "video")).toBe("openai-video");
    expect(resolveProvider(cfg, "any-dynamic-video", "video")).toBe("openai-video");
  });
  it("image uses providerMap then per-type default", () => {
    expect(resolveProvider(cfg, "gpt-image-2-token", "image")).toBe("chat-completions");
    expect(resolveProvider(cfg, "unknown-image", "image")).toBe("chat-completions");
  });
  it("pricing uses the table then falls back to per-type default", () => {
    expect(resolvePricing(cfg, "gpt-image-2-token", "image").unitPrice).toBe(0.04);
    expect(resolvePricing(cfg, "brand-new-llm", "llm")).toEqual(cfg.defaultPricing.llm);
  });
  it("enrichCatalog builds three typed buckets", () => {
    const out = enrichCatalog(cfg, { llm: ["gpt-5.4"], image: ["gpt-image-2-token"], video: ["veo3.1"] });
    expect(out.llm[0]).toEqual({ id: "gpt-5.4", type: "llm", provider: "openai", pricing: cfg.defaultPricing.llm });
    expect(out.video[0].provider).toBe("openai-video");
  });
  it("stably moves Claude LLMs behind other models before choosing a default", () => {
    const out = enrichCatalog(cfg, {
      llm: ["claude-opus-4.1", "gpt-5.4", "Claude-Sonnet-4.5", "deepseek-v4"],
      image: ["gpt-image-2-token"],
      video: ["veo3.1"],
    });
    expect(out.llm.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "deepseek-v4",
      "claude-opus-4.1",
      "Claude-Sonnet-4.5",
    ]);
    expect(out.image.map((model) => model.id)).toEqual(["gpt-image-2-token"]);
    expect(out.video.map((model) => model.id)).toEqual(["veo3.1"]);
  });
  it("does not mutate cached model arrays while normalizing their order", () => {
    const input = [{ id: "claude-4" }, { id: "gpt-5.4" }];
    expect(moveClaudeModelsToEnd(input).map((model) => model.id)).toEqual(["gpt-5.4", "claude-4"]);
    expect(input.map((model) => model.id)).toEqual(["claude-4", "gpt-5.4"]);
  });
});
