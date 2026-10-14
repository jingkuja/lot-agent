import type { ModelConfig } from "@lot-agent/core";
import { AnalysisError } from "./errors.js";
import { ANALYSIS_MODELS } from "./models.js";

export const ANALYSIS_QUEUE = "lot-media-analysis";
export const ANALYSIS_JOB = "marketing.analysis";
export interface AnalysisConfig {
  enabled: boolean; budget: number; pricing: ModelConfig[]; downloaderVersion: string; concurrency: number;
}
/** Prices are operator-verified gateway prices in CNY / 1,000 tokens. No
 * fallback to another model's rate, and no zero-cost unknown Kimi model. */
export function analysisConfig(env: NodeJS.ProcessEnv = process.env): AnalysisConfig {
  if (env.MARKETING_ANALYSIS_ENABLED !== "1") return { enabled: false, budget: 0, pricing: [], downloaderVersion: "", concurrency: 1 };
  const budget = Number(env.MARKETING_ANALYSIS_BUDGET_CNY);
  const concurrency = Number(env.MARKETING_ANALYSIS_CONCURRENCY ?? 2);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4
    || !/^\d{4}\.\d{2}\.\d{2}$/.test(env.YTDLP_VERSION ?? "") || !env.SECRET_MASTER_KEY) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
  let prices: Record<string, any>;
  try { prices = JSON.parse(env.MARKETING_ANALYSIS_PRICING ?? "{}"); } catch { throw new AnalysisError("ANALYSIS_PRICING_REQUIRED", 503); }
  const pricing = Object.values(ANALYSIS_MODELS).map((id): ModelConfig => {
    const p = prices?.[id];
    if (!p || ![p.inputPrice, p.outputPrice].every(n => typeof n === "number" && Number.isFinite(n) && n > 0)) throw new AnalysisError("ANALYSIS_PRICING_REQUIRED", 503);
    return { id, type: "llm", provider: "openai", enabled: true, billingUnit: "token", unitPrice: 0, inputPrice: p.inputPrice, outputPrice: p.outputPrice };
  });
  return { enabled: true, budget, pricing, downloaderVersion: env.YTDLP_VERSION!, concurrency };
}
