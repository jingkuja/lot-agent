import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ComicFrozenGenerationInput } from "@lot-agent/core/comic-drama";
import { lookupPricing, resolvePricing, type ModelCatalogConfig } from "../models/catalog.js";
import { comicQuoteCurrency, quoteComicImageCatalogPrice, quoteComicVideoPrices, readComicVideoEstimateDeviations } from "./pricing.js";

const baseCatalog: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "openai-images", video: "openai-video" },
  providerMap: { "gpt-image-2": "openai-images", "free-image": "openai-images" },
  pricing: {
    "gpt-image-2": { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    "free-image": { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
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
    expect(quoteComicImageCatalogPrice(emptyCatalog, "gpt-image-2", {})).toBeNull();

    expect(quoteComicImageCatalogPrice(baseCatalog, "free-image", {})).toEqual({
      modelId: "free-image", amountMicros: 0, unit: "image", currency: "CNY",
    });
  });

  it("applies defaultPricing for images", () => {
    const fallbackCatalog: ModelCatalogConfig = { ...baseCatalog, pricing: {} };
    expect(quoteComicImageCatalogPrice(fallbackCatalog, "qwen-image-2.0", {})).toEqual({
      modelId: "qwen-image-2.0", amountMicros: 40_000, unit: "image", currency: "CNY",
    });
  });

  it("rejects negative prices", () => {
    const badCatalog: ModelCatalogConfig = {
      ...baseCatalog,
      pricing: { "gpt-image-2": { inputPrice: 0, outputPrice: 0, unitPrice: -1 } },
      defaultPricing: {},
    };
    expect(quoteComicImageCatalogPrice(badCatalog, "gpt-image-2", {})).toBeNull();
  });

  it("outputs currency per settlement mode (USD in international mode, CNY in domestic, explicit override)", () => {
    expect(comicQuoteCurrency({})).toBe("CNY");
    expect(comicQuoteCurrency({ globle: "1" })).toBe("USD");
    expect(comicQuoteCurrency({ globle: "1", COMIC_DRAMA_QUOTE_CURRENCY: "CNY" })).toBe("CNY");
    expect(comicQuoteCurrency({ COMIC_DRAMA_QUOTE_CURRENCY: "USD" })).toBe("USD");
    expect(quoteComicImageCatalogPrice(baseCatalog, "gpt-image-2", { globle: "1" })?.currency).toBe("USD");
  });
});

const videoInput: ComicFrozenGenerationInput = {
  schemaVersion: 1, promptVersion: 1, seriesId: "series", seriesRevision: 1, clipId: "first", clipRevision: 1,
  mode: "references", modelId: "doubao-seedance-2-5", aspectRatio: "9:16", durationMs: 8000, resolution: "720p",
  styleKey: "webtoon", prompt: "A city", firstFrame: null, references: [],
};
const model = videoInput.modelId;

describe("comic video pricing", () => {
  it("deduplicates equal usage, converts the gateway quote, and leaves a failed clip unpriced", async () => {
    const gateway = {
      listModels: vi.fn(async () => ({ llm: [], image: [], video: [model], video_token_models: [model] })),
      estimateModelCost: vi.fn()
        .mockResolvedValueOnce({ model, pricingScheme: "video_token", estimatedPoints: 20, estimatedQuota: 100_000 })
        .mockRejectedValueOnce(new Error("quote unavailable")),
    };
    const units = async () => ({ quotaPerUnit: 500_000, currency: "CNY" as const, exchangeRate: 7 });
    expect(await quoteComicVideoPrices(gateway, { units }, "owner-key", model, [
      videoInput, { ...videoInput, clipId: "same" }, { ...videoInput, clipId: "failed", resolution: "4k" },
    ], new AbortController().signal)).toEqual({
      modelId: model, unit: "second", currency: "CNY", clipAmounts: { first: 1_400_000, same: 1_400_000 }, videoTokenEstimate: true,
    });
    expect(gateway.estimateModelCost).toHaveBeenCalledTimes(2);
    expect(gateway.estimateModelCost).toHaveBeenCalledWith("owner-key", expect.objectContaining({
      model, video: expect.objectContaining({ total_tokens: 172_800 }),
    }), expect.any(AbortSignal));
  });

  it("reports the observed error range only for a comparable cohort with at least ten actual charges", async () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, index) => ({ input: videoInput, quote: "100", actual: String(90 + 2 * index) })),
      { input: { ...videoInput, resolution: "4k" }, quote: "100", actual: "120" },
    ];
    const query = vi.fn().mockResolvedValue({ rows });
    const price = { modelId: model, currency: "USD", unit: "second", clipAmounts: {} } as const;
    const result = await readComicVideoEstimateDeviations({ query } as Pick<Pool, "query">, "owner", price,
      [videoInput, { ...videoInput, clipId: "other", resolution: "4k" }]);
    expect(query).toHaveBeenCalledWith(expect.any(String), ["owner", model, "USD"]);
    expect(result.size).toBe(1);
    expect(result.get(videoInput.clipId)).toMatchObject({ sampleCount: 11 });
    expect(result.get(videoInput.clipId)?.low).toBeCloseTo(-0.08);
    expect(result.get(videoInput.clipId)?.high).toBeCloseTo(0.08);
  });
});
