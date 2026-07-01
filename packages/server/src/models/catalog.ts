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

/** LLM always uses its default provider (openai-compatible). Image/video look up
 * the per-model providerMap, then fall back to the per-type default. */
export function resolveProvider(cfg: ModelCatalogConfig, id: string, type: string): string {
  if (type === "llm") return cfg.defaultProvider.llm;
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
