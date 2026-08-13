import { describe, it, expect, vi } from "vitest";
import { makePricingLookup } from "./pricing-lookup.js";
import type { ModelCatalogConfig } from "../models/catalog.js";
import type { ModelConfig } from "@lot-agent/core";

const catalog: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
  providerMap: {},
  pricing: {
    "catalog-llm": { inputPrice: 0.01, outputPrice: 0.02, unitPrice: 0 },
  },
  defaultPricing: {
    llm: { inputPrice: 0.001, outputPrice: 0.002, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
  },
};

const staticConfig: ModelConfig = {
  id: "static-model",
  type: "llm",
  provider: "openai",
  billingUnit: "token",
  inputPrice: 0.5,
  outputPrice: 0.6,
  unitPrice: 0,
  enabled: true,
};

describe("makePricingLookup", () => {
  it("prefers the static lookup when it has an entry", () => {
    const staticLookup = vi.fn((id: string) => (id === "static-model" ? staticConfig : undefined));
    const lookup = makePricingLookup(staticLookup, catalog);
    expect(lookup("static-model")).toEqual(staticConfig);
  });

  it("falls back to catalog pricing (exact id) when the static lookup misses", () => {
    const staticLookup = () => undefined;
    const lookup = makePricingLookup(staticLookup, catalog);
    const cfg = lookup("catalog-llm");
    expect(cfg).toMatchObject({ id: "catalog-llm", type: "llm", inputPrice: 0.01, outputPrice: 0.02 });
  });

  it("falls back to the catalog's per-type default pricing for a wholly unknown model", () => {
    const staticLookup = () => undefined;
    const lookup = makePricingLookup(staticLookup, catalog);
    // "brand-new-model" is in neither the static map nor catalog.pricing —
    // this is the same dynamic-tokenhub-model case memory.extract hits.
    // catalogModelConfig (which this helper is required to reuse) always
    // synthesizes a ModelConfig — falling back to defaultPricing[type], and
    // ultimately to a zero-priced config — so a call is still metered
    // (usage_log row written, cost 0 if truly unpriced) instead of being
    // silently dropped as "unknown model".
    const cfg = lookup("brand-new-model");
    expect(cfg).toMatchObject({ id: "brand-new-model", type: "llm", inputPrice: 0.001, outputPrice: 0.002 });
  });

  it("still returns a defined (zero-priced) config when even the type default is missing", () => {
    const bareCatalog: ModelCatalogConfig = {
      defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
      providerMap: {},
      pricing: {},
      defaultPricing: {},
    };
    const lookup = makePricingLookup(() => undefined, bareCatalog);
    const cfg = lookup("anything");
    expect(cfg).toMatchObject({ id: "anything", inputPrice: 0, outputPrice: 0, unitPrice: 0 });
  });
});
