import { describe, it, expect } from "vitest";
import { OpenAIProvider, OpenAIImagesImageProvider, HttpVideoGenerationProvider } from "@lot-agent/core";
import { ProviderFactory } from "./provider-factory.js";
import type { ModelCatalogConfig } from "./catalog.js";
import type { MediaGenerationConfig } from "../generation/config.js";

const catalog: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "openai-images", video: "happyhorse" },
  providerMap: { "veo3.1": "happyhorse", "gpt-image-2-token": "openai-images" },
  pricing: {}, defaultPricing: {
    llm: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
  },
};
const media = (): MediaGenerationConfig => ({
  baseUrl: "https://h/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "", modelId: "",
});

const f = new ProviderFactory({
  catalog, llmBaseUrl: "https://h/v1", imageBase: media(), videoBase: media(),
});

describe("ProviderFactory", () => {
  it("llm → OpenAIProvider", () => {
    expect(f.llm("gpt-5.4", "sk-u")).toBeInstanceOf(OpenAIProvider);
  });
  it("image → OpenAIImagesImageProvider when adapter resolves to openai-images", () => {
    expect(f.image("gpt-image-2-token", "sk-u")).toBeInstanceOf(OpenAIImagesImageProvider);
  });
  it("video → HttpVideoGenerationProvider (happyhorse) with real key", () => {
    expect(f.video("veo3.1", "sk-u")).toBeInstanceOf(HttpVideoGenerationProvider);
  });
});
