import type { LLMProvider } from "../types/index.js";
import { OpenAIProvider, type OpenAIProviderConfig } from "./openai.js";
import { AnthropicProvider, type AnthropicProviderConfig } from "./anthropic.js";

export type ProviderType = "openai" | "anthropic";

export interface LLMConfig {
  default: ProviderType;
  openai: OpenAIProviderConfig;
  anthropic: AnthropicProviderConfig;
}

export function createLLMProvider(
  config: LLMConfig,
  override?: ProviderType
): LLMProvider {
  const type = override ?? config.default;

  switch (type) {
    case "openai":
      if (!config.openai.apiKey) throw new Error("OpenAI API key is required");
      return new OpenAIProvider(config.openai);
    case "anthropic":
      if (!config.anthropic.apiKey)
        throw new Error("Anthropic API key is required");
      return new AnthropicProvider(config.anthropic);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}
