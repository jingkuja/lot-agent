import { TokenhubEmbeddingProvider } from "../knowledge/ingestion/embedding.js";
import { OpenAIProvider, OpenAIResponsesProvider, type LLMProvider, type ImageGenerationProvider, type VideoGenerationProvider } from "@lot-agent/core";
import { makeImageProvider, makeVideoProvider, type MediaGenerationConfig } from "../generation/config.js";
import { resolveProvider, type ModelCatalogConfig } from "./catalog.js";
import { gatewayModelHeaders } from "../tokenhub/model-access.js";

export interface ProviderFactoryDeps {
  catalog: ModelCatalogConfig;
  llmBaseUrl: string;
  llmProtocol?: "chat-completions" | "responses";
  llmFetch?: typeof fetch;
  imageBase: MediaGenerationConfig;
  videoBase: MediaGenerationConfig;
}

/** Builds a provider bound to a specific user's api_key + selected model, per
 * request. Model calls are billed to the caller's tokenhub key, so providers
 * cannot be shared startup singletons. Construction is cheap (config only). */
export class ProviderFactory {
  constructor(private readonly deps: ProviderFactoryDeps) {}

  llm(modelId: string, apiKey: string, protocol = this.deps.catalog.llmProtocols?.[modelId] ?? this.deps.llmProtocol): LLMProvider {
    const Provider = protocol === "responses" ? OpenAIResponsesProvider : OpenAIProvider;
    return new Provider({ apiKey, baseUrl: this.deps.llmBaseUrl, model: modelId, headers: gatewayModelHeaders(), fetch: this.deps.llmFetch });
  }

  embedding(modelId: string, apiKey: string, dimensions: number, onUsage: (tokens: number) => Promise<void>) {
    return new TokenhubEmbeddingProvider({ baseUrl: this.deps.llmBaseUrl, apiKey, model: modelId, dimensions, onUsage });
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
