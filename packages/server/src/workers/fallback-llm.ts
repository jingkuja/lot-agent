import {
  createLLMProvider,
  type LLMConfig,
  type LLMProvider,
} from "@lot-agent/core";

/**
 * Build the worker's env-configured fallback LLM only when the selected
 * provider has a key. Per-user tokenhub providers do not need this fallback,
 * so a missing env key must not prevent the generation worker from starting.
 */
export function createOptionalFallbackLLM(config: LLMConfig): LLMProvider | null {
  const apiKey =
    config.default === "openai"
      ? config.openai.apiKey
      : config.anthropic.apiKey;
  return apiKey ? createLLMProvider(config) : null;
}
