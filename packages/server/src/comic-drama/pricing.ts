import { comicVideoProfile } from "@lot-agent/core/comic-drama";
import { lookupPricing, resolveProvider, type ModelCatalogConfig } from "../models/catalog.js";
import type { ComicPrice } from "./generation-repository.js";

/** Settlement quote currency follows explicit config first, then international mode (`globle > 0` => USD, domestic => CNY). */
export function comicQuoteCurrency(env: NodeJS.ProcessEnv = process.env): "CNY" | "USD" {
  const configured = env.COMIC_DRAMA_QUOTE_CURRENCY?.trim().toUpperCase();
  if (configured === "CNY" || configured === "USD") return configured;
  const globle = Number(env.globle);
  return Number.isFinite(globle) && globle > 0 ? "USD" : "CNY";
}

/**
 * Unified catalog quote rule for both comic-drama images and videos:
 * 1. Model must match the supported provider (and video profile for videos).
 * 2. Pricing looks up `catalog.pricing[modelId]`, then falls back to `catalog.defaultPricing[kind]` identically for image & video.
 * 3. Missing pricing returns `null` (never silently coerced to 0), while an explicit `unitPrice: 0` is preserved as `amountMicros: 0`.
 */
export function quoteComicCatalogPrice(
  catalog: ModelCatalogConfig,
  kind: "image" | "video",
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): ComicPrice | null {
  if (!modelId) return null;
  if (kind === "image") {
    if (resolveProvider(catalog, modelId, "image") !== "openai-images") return null;
  } else {
    if (!comicVideoProfile(modelId) || resolveProvider(catalog, modelId, "video") !== "openai-video") return null;
  }
  const entry = lookupPricing(catalog, modelId, kind, { fallbackToDefault: true });
  if (!entry || typeof entry.unitPrice !== "number" || !Number.isFinite(entry.unitPrice) || entry.unitPrice < 0) {
    return null;
  }
  const amountMicros = Math.round(entry.unitPrice * 1_000_000);
  const maxUnits = kind === "video" ? 150 : 10;
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || amountMicros > Math.floor(Number.MAX_SAFE_INTEGER / maxUnits)) {
    return null;
  }
  return {
    modelId,
    amountMicros,
    unit: kind === "video" ? "second" : "image",
    currency: comicQuoteCurrency(env),
  };
}
