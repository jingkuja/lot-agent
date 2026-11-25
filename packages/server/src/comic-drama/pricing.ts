import type { Pool } from "pg";
import type { ComicFrozenGenerationInput, ComicQuoteLine } from "@lot-agent/core/comic-drama";
import { predictModelCost } from "../billing/model-estimate.js";
import { lookupPricing, resolveProvider, type ModelCatalogConfig } from "../models/catalog.js";
import type { TokenhubBillingLogs } from "../tokenhub/billing-logs.js";
import type { TokenhubClient } from "../tokenhub/client.js";
import { comicVideoEstimateUsage } from "./credit-check.js";
import type { ComicPrice, ComicVideoPrices } from "./generation-repository.js";

/** Catalog quote currency follows explicit config first, then international mode. */
export function comicQuoteCurrency(env: NodeJS.ProcessEnv = process.env): "CNY" | "USD" {
  const configured = env.COMIC_DRAMA_QUOTE_CURRENCY?.trim().toUpperCase();
  if (configured === "CNY" || configured === "USD") return configured;
  const globle = Number(env.globle);
  return Number.isFinite(globle) && globle > 0 ? "USD" : "CNY";
}

export function quoteComicImageCatalogPrice(
  catalog: ModelCatalogConfig,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): ComicPrice | null {
  if (!modelId || resolveProvider(catalog, modelId, "image") !== "openai-images") return null;
  const entry = lookupPricing(catalog, modelId, "image", { fallbackToDefault: true });
  if (!entry || typeof entry.unitPrice !== "number" || !Number.isFinite(entry.unitPrice) || entry.unitPrice < 0) {
    return null;
  }
  const amountMicros = Math.round(entry.unitPrice * 1_000_000);
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || amountMicros > Math.floor(Number.MAX_SAFE_INTEGER / 10)) {
    return null;
  }
  return {
    modelId,
    amountMicros,
    unit: "image",
    currency: comicQuoteCurrency(env),
  };
}

export async function quoteComicVideoPrices(
  tokenhub: Pick<TokenhubClient, "listModels" | "estimateModelCost">, billing: Pick<TokenhubBillingLogs, "units">,
  apiKey: string, modelId: string, inputs: ComicFrozenGenerationInput[], signal: AbortSignal,
): Promise<ComicVideoPrices | null> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  try {
    const [models, { currency, exchangeRate }] = await Promise.all([tokenhub.listModels(apiKey, deadline), billing.units(deadline)]);
    if (!models.video.includes(modelId)) return null;
    const prices: ComicVideoPrices = { modelId, currency, unit: "second", clipAmounts: {} };
    const unique = new Map<string, Promise<Awaited<ReturnType<typeof predictModelCost>>>>();
    const estimates = {
      listModels: async () => models,
      estimateModelCost: tokenhub.estimateModelCost.bind(tokenhub),
    };
    for (let offset = 0; offset < inputs.length && !deadline.aborted; offset += 4) {
      await Promise.allSettled(inputs.slice(offset, offset + 4).map(async input => {
        const count = input.references.length + Number(!!input.firstFrame) + Number(!!input.lastFrame);
        const usage = comicVideoEstimateUsage(input, count);
        const key = JSON.stringify(usage);
        let prediction = unique.get(key);
        if (!prediction) {
          prediction = predictModelCost(estimates, apiKey, usage, deadline);
          unique.set(key, prediction);
        }
        const estimate = await prediction;
        const amount = Math.round(estimate.estimatedPoints / 100 * exchangeRate * 1_000_000);
        if (Number.isSafeInteger(amount) && amount >= 0) prices.clipAmounts[input.clipId] = amount;
        if (estimate.pricingScheme === "video_token") prices.videoTokenEstimate = true;
      }));
    }
    signal.throwIfAborted();
    return Object.keys(prices.clipAmounts).length ? prices : null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function videoPricingFacts(input: ComicFrozenGenerationInput): string {
  const { video, request_parameters: parameters } = comicVideoEstimateUsage(input, 0);
  return JSON.stringify([
    video?.resolution, input.mode, input.durationMs, !!input.sourceDuration, parameters?.estimate_ratio ?? parameters?.ratio,
    Math.round(Number(parameters?.reference_video_seconds ?? 0)), parameters?.generate_audio,
  ]);
}

export async function readComicVideoEstimateDeviations(
  pool: Pick<Pool, "query">, owner: string, price: ComicVideoPrices, inputs: ComicFrozenGenerationInput[],
) {
  const { rows } = await pool.query<{ input: ComicFrozenGenerationInput; quote: string; actual: string }>(`
    SELECT t.input,r.frozen->'price'->'clipAmounts'->>t.target_id::text AS quote,t.settled_amount_micros::text AS actual
    FROM lot_comic_drama.cd_takes t
    JOIN lot_comic_drama.cd_generation_requests r ON (r.owner_id,r.id)=(t.owner_id,t.request_id)
    WHERE t.owner_id=$1 AND t.video_version IS NOT NULL AND t.input->>'modelId'=$2 AND t.settled_currency=$3
      AND r.frozen->'price'->>'currency'=$3 AND r.frozen->'price'->>'videoTokenEstimate'='true' AND t.settled_source LIKE 'tokenhub:task:%'
    ORDER BY t.settled_at DESC,t.id LIMIT 200`, [owner, price.modelId, price.currency]);
  const samples = new Map<string, number[]>();
  for (const { input, quote, actual } of rows) {
    const estimated = Number(quote);
    if (estimated <= 0) continue;
    const error = Number(actual) / estimated - 1;
    if (!Number.isFinite(error)) continue;
    const key = videoPricingFacts(input);
    const points = samples.get(key) ?? [];
    points.push(error);
    samples.set(key, points);
  }
  for (const points of samples.values()) points.sort((a, b) => a - b);
  const ranges = new Map<string, NonNullable<ComicQuoteLine["videoEstimateDeviation"]>>();
  for (const input of inputs) {
    const points = samples.get(videoPricingFacts(input));
    if (!points || points.length < 10) continue;
    const last = points.length - 1;
    ranges.set(input.clipId, { low: points[Math.floor(last * 0.1)], high: points[Math.ceil(last * 0.9)], sampleCount: points.length });
  }
  return ranges;
}
