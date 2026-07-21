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
  providerMap: Record<string, string>;
  defaultProvider: Record<string, string>;
  pricing: Record<string, Pricing>;
  defaultPricing: Record<string, Pricing>;
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
  return { llm: build(models.llm, "llm"), image: build(models.image, "image"), video: build(models.video, "video") };
}
