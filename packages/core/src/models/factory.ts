import type { ModelRegistry, ModelConfig } from "./types.js";
import type { LLMConfig } from "../llm/factory.js";
import { OpenAIProvider } from "../llm/openai.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { StubImageProvider } from "../providers/image.js";
import { StubVideoProvider } from "../providers/video.js";
import { StubTTSProvider } from "../providers/tts.js";

/** Populate a ModelRegistry from config.models, wiring provider factories per type. */
export function populateModelRegistry(
  registry: ModelRegistry,
  models: ModelConfig[],
  llmConfig: LLMConfig
): void {
  for (const m of models) {
    if (!m.enabled) continue;
    registry.register(m, () => {
      if (m.type === "llm") {
        if (m.provider === "anthropic") {
          return new AnthropicProvider({ apiKey: llmConfig.anthropic.apiKey, model: m.id });
        }
        // default/openai-compatible (deepseek etc.)
        return new OpenAIProvider({ apiKey: llmConfig.openai.apiKey, baseUrl: llmConfig.openai.baseUrl, model: m.id });
      }
      if (m.type === "image") return new StubImageProvider();
      if (m.type === "video") return new StubVideoProvider();
      if (m.type === "tts") return new StubTTSProvider();
      throw new Error(`No provider factory for model type: ${m.type}`);
    });
  }
}
