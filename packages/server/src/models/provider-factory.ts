import { OpenAIProvider, type LLMProvider, type ImageGenerationProvider, type VideoGenerationProvider } from "@lot-agent/core";
import { makeImageProvider, makeVideoProvider, type MediaGenerationConfig } from "../generation/config.js";
import { resolveProvider, type ModelCatalogConfig } from "./catalog.js";

export interface ProviderFactoryDeps {
  catalog: ModelCatalogConfig;
  llmBaseUrl: string;
  imageBase: MediaGenerationConfig;
  videoBase: MediaGenerationConfig;
}

/** Builds a provider bound to a specific user's api_key + selected model, per
 * request. Model calls are billed to the caller's tokenhub key, so providers
 * cannot be shared startup singletons. Construction is cheap (config only). */
export class ProviderFactory {
  constructor(private readonly deps: ProviderFactoryDeps) {}

  llm(modelId: string, apiKey: string): LLMProvider {
    return new OpenAIProvider({ apiKey, baseUrl: this.deps.llmBaseUrl, model: modelId });
  }

  image(modelId: string, apiKey: string): ImageGenerationProvider {
    const adapter = resolveProvider(this.deps.catalog, modelId, "image");
    return makeImageProvider({ ...this.deps.imageBase, apiKey, model: modelId, mock: false, adapter });
  }

  video(modelId: string, apiKey: string): VideoGenerationProvider {
    const adapter = resolveProvider(this.deps.catalog, modelId, "video");
    return makeVideoProvider({ ...this.deps.videoBase, apiKey, model: modelId, mock: false, adapter });
  }
}
