import { isAnthropicModel, isPortraitVideoModel } from "@lot-agent/core";
import { internationalModelsEnabled } from "../tokenhub/model-access.js";

export interface Pricing {
  inputPrice: number;
  outputPrice: number;
  unitPrice: number;
}
export interface CatalogModel {
  id: string;
  type: "llm" | "image" | "video";
  provider: string;
  pricing: Pricing;
}
export interface ModelCatalogConfig {
  llmProtocols?: Record<string, "chat-completions" | "responses">;
  providerMap: Record<string, string>;
  defaultProvider: Record<string, string>;
  pricing: Record<string, Pricing>;
  defaultPricing: Record<string, Pricing>;
}

/** Cheap model for background work; the configured default when nothing else is chosen. */
export const UTILITY_LLM_MODEL = "deepseek-v4.1-flash";
const DOMESTIC_DEFAULT_LLMS = ["kimi-k3.1-pro"];
const INTERNATIONAL_DEFAULT_LLMS = ["claude-sonnet-5-5", "claude-opus-5-5"];

/** The deployment's default model first, then deepseek-v4.1-flash, other models, and Claude
 * last because it is expensive. This server order is the only one: the first entry is
 * what the web picker shows and selects. */
export function orderLlmModels<T extends { id: string }>(models: T[], international = internationalModelsEnabled()): T[] {
  const available = new Set(models.map((model) => model.id));
  const defaultId = (international ? INTERNATIONAL_DEFAULT_LLMS : DOMESTIC_DEFAULT_LLMS).find((id) => available.has(id));
  const rank = ({ id }: T) => id === defaultId ? 0 : id === UTILITY_LLM_MODEL ? 1 : isAnthropicModel(id) ? 3 : 2;
  return [...models].sort((a, b) => rank(a) - rank(b));
}

/** Titles, query rewrites, memory extraction and other background work never run on
 * Claude, and never follow the catalog's first entry, which may be a premium default. */
export function pickUtilityLlmModel(modelIds: string[]): string | null {
  if (modelIds.includes(UTILITY_LLM_MODEL)) return UTILITY_LLM_MODEL;
  return modelIds.find((id) => !isAnthropicModel(id)) ?? null;
}

const BACKGROUND_TASK_LLM = { domestic: "kimi-k3.1-pro", international: "gpt-6.1-terra" };

/** Default for long tasks the owner leaves running, and for them alone. Without it, the same pick as background work. */
export function pickBackgroundTaskLlmModel(modelIds: string[], international = internationalModelsEnabled()): string | null {
  const preferred = international ? BACKGROUND_TASK_LLM.international : BACKGROUND_TASK_LLM.domestic;
  return modelIds.includes(preferred) ? preferred : pickUtilityLlmModel(modelIds);
}

/** LLM and video always use their per-type default provider (all video models
 * route through the same tokenhub `/videos` endpoint, so per-model matching is
 * meaningless and would break for dynamic agent-market models not in the map).
 * Only image still looks up the per-model providerMap before its default. */
export function resolveProvider(cfg: ModelCatalogConfig, id: string, type: string): string {
  if (type === "llm") return cfg.defaultProvider.llm;
  if (type === "video") return cfg.defaultProvider.video ?? cfg.defaultProvider.llm;
  return cfg.providerMap[id] ?? cfg.defaultProvider[type] ?? cfg.defaultProvider.llm;
}

export function resolvePricing(cfg: ModelCatalogConfig, id: string, type: string): Pricing {
  return cfg.pricing[id] ?? cfg.defaultPricing[type] ?? { inputPrice: 0, outputPrice: 0, unitPrice: 0 };
}

export function enrichCatalog(
  cfg: ModelCatalogConfig,
  models: { llm: string[]; image: string[]; video: string[] }
): { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] } {
  const build = (ids: string[], type: "llm" | "image" | "video"): CatalogModel[] =>
    ids.map((id) => ({
      id,
      type,
      provider: resolveProvider(cfg, id, type),
      pricing: resolvePricing(cfg, id, type),
    }));
  return {
    llm: orderLlmModels(build(models.llm, "llm")),
    image: build(models.image, "image"),
    video: build(models.video.filter((id) => !isPortraitVideoModel(id)), "video"),
  };
}
