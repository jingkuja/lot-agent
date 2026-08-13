import { describe, expect, it } from "vitest";
import type { LLMConfig } from "@lot-agent/core";
import { createOptionalFallbackLLM } from "./fallback-llm.js";

function config(defaultProvider: "openai" | "anthropic", apiKey = ""): LLMConfig {
  return {
    default: defaultProvider,
    openai: {
      apiKey: defaultProvider === "openai" ? apiKey : "",
      baseUrl: "https://api.example.com/v1",
      model: "openai-model",
    },
    anthropic: {
      apiKey: defaultProvider === "anthropic" ? apiKey : "",
      model: "anthropic-model",
    },
  };
}

describe("createOptionalFallbackLLM", () => {
  it("returns null instead of throwing when the selected provider has no API key", () => {
    expect(createOptionalFallbackLLM(config("openai"))).toBeNull();
    expect(createOptionalFallbackLLM(config("anthropic"))).toBeNull();
  });

  it("creates the fallback provider when its API key is configured", () => {
    expect(createOptionalFallbackLLM(config("openai", "sk-test"))).not.toBeNull();
    expect(createOptionalFallbackLLM(config("anthropic", "sk-test"))).not.toBeNull();
  });
});
