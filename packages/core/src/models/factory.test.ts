import { expect, it } from "vitest";
import { InMemoryModelRegistry } from "./registry.js";
import { populateModelRegistry } from "./factory.js";
import { OpenAIResponsesProvider } from "../llm/responses.js";
import { OpenAIProvider } from "../llm/openai.js";

it("routes registry providers through per-model protocol overrides without changing Chat defaults", () => {
  const registry = new InMemoryModelRegistry();
  const config = { default: "openai" as const, openai: { apiKey: "test", model: "a" }, anthropic: { apiKey: "test", model: "a" } };
  populateModelRegistry(registry, ["a", "b"].map(id => ({ id, provider: "openai", type: "llm", enabled: true, billingUnit: "token", inputPrice: 1, outputPrice: 1, unitPrice: 0 })), config, { a: "responses" });
  expect(registry.getProvider("a")).toBeInstanceOf(OpenAIResponsesProvider);
  expect(registry.getProvider("b")).toBeInstanceOf(OpenAIProvider);
});
