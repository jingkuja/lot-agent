import type { ModelConfig, ModelType } from "@lot-agent/core";
import { catalogModelConfig } from "../services/agent-service.js";
import type { ModelCatalogConfig } from "../models/catalog.js";

/**
 * Shared pricing-lookup builder for `UsageMeter` (#18): static `models` config
 * wins when it has an entry, otherwise fall back to the tokenhub model
 * catalog's pricing table. Both the server (agent-service.ts) and the worker
 * (workers/index.ts) must resolve dynamically-discovered model ids the same
 * way — the worker previously only checked the static map, so
 * `memory.extract` jobs running on a dynamic tokenhub model id were silently
 * skipped as "unknown model" instead of being billed via the catalog
 * fallback like the server's chat path.
 */
export function makePricingLookup(
  staticLookup: (id: string) => ModelConfig | undefined,
  catalog: ModelCatalogConfig,
  type: ModelType = "llm"
): (id: string) => ModelConfig | undefined {
  return (id: string) => staticLookup(id) ?? catalogModelConfig(catalog, id, type);
}
