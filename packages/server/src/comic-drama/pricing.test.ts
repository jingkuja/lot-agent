import { describe, expect, it } from "vitest";
import { lookupPricing, resolvePricing, type ModelCatalogConfig } from "../models/catalog.js";
import { comicQuoteCurrency, quoteComicCatalogPrice } from "./pricing.js";

const baseCatalog: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "openai-images", video: "openai-video" },
  providerMap: { "gpt-image-2": "openai-images", "free-image": "openai-images" },
  pricing: {
    "gpt-image-2": { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    "free-image": { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
    "kling-video-v3-omni": { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
    "grok-imagine-video-1.5": { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
  },
  defaultPricing: {
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
  },
};

describe("comic-drama pricing and catalog lookup", () => {
  it("distinguishes explicit zero pricing from missing pricing", () => {
    const emptyCatalog: ModelCatalogConfig = { ...baseCatalog, pricing: {}, defaultPricing: {} };
    expect(lookupPricing(emptyCatalog, "gpt-image-2", "image", { fallbackToDefault: true })).toBeNull();
    expect(resolvePricing(emptyCatalog, "gpt-image-2", "image").unitPrice).toBe(0);
    expect(quoteComicCatalogPrice(emptyCatalog, "image", "gpt-image-2", {})).toBeNull();
    expect(quoteComicCatalogPrice(emptyCatalog, "video", "kling-video-v3-omni", {})).toBeNull();

    expect(quoteComicCatalogPrice(baseCatalog, "image", "free-image", {})).toEqual({
      modelId: "free-image", amountMicros: 0, unit: "image", currency: "CNY",
    });
    expect(quoteComicCatalogPrice(baseCatalog, "video", "grok-imagine-video-1.5", {})).toEqual({
      modelId: "grok-imagine-video-1.5", amountMicros: 0, unit: "second", currency: "CNY",
    });
  });

  it("applies defaultPricing consistently to both image and video models", () => {
    const fallbackCatalog: ModelCatalogConfig = { ...baseCatalog, pricing: {} };
    expect(quoteComicCatalogPrice(fallbackCatalog, "image", "qwen-image-2.0", {})).toEqual({
      modelId: "qwen-image-2.0", amountMicros: 40_000, unit: "image", currency: "CNY",
    });
    expect(quoteComicCatalogPrice(fallbackCatalog, "video", "grok-imagine-video-1.5", {})).toEqual({
      modelId: "grok-imagine-video-1.5", amountMicros: 500_000, unit: "second", currency: "CNY",
    });
  });

  it("rejects unsupported video models and negative or non-finite prices", () => {
    expect(quoteComicCatalogPrice(baseCatalog, "video", "unsupported-video-model", {})).toBeNull();
    const badCatalog: ModelCatalogConfig = {
      ...baseCatalog,
      pricing: { "gpt-image-2": { inputPrice: 0, outputPrice: 0, unitPrice: -1 } },
      defaultPricing: {},
    };
    expect(quoteComicCatalogPrice(badCatalog, "image", "gpt-image-2", {})).toBeNull();
  });

  it("outputs currency per settlement mode (USD in international mode, CNY in domestic, explicit override)", () => {
    expect(comicQuoteCurrency({})).toBe("CNY");
    expect(comicQuoteCurrency({ globle: "1" })).toBe("USD");
    expect(comicQuoteCurrency({ globle: "1", COMIC_DRAMA_QUOTE_CURRENCY: "CNY" })).toBe("CNY");
    expect(comicQuoteCurrency({ COMIC_DRAMA_QUOTE_CURRENCY: "USD" })).toBe("USD");
    expect(quoteComicCatalogPrice(baseCatalog, "video", "kling-video-v3-omni", { globle: "1" })?.currency).toBe("USD");
  });
});
