import { afterEach, describe, it, expect, vi } from "vitest";
import { OpenAIProvider, OpenAIResponsesProvider, OpenAIImagesImageProvider, HttpVideoGenerationProvider } from "@lot-agent/core";
import { ProviderFactory } from "./provider-factory.js";
import type { ModelCatalogConfig } from "./catalog.js";
import type { MediaGenerationConfig } from "../generation/config.js";

const catalog: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "openai-images", video: "happyhorse" },
  providerMap: { "veo3.1": "happyhorse", "gpt-image-2-token": "openai-images" },
  pricing: {}, defaultPricing: {
    llm: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
  },
};
const media = (): MediaGenerationConfig => ({
  baseUrl: "https://h/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "", modelId: "",
});

const f = new ProviderFactory({
  catalog, llmBaseUrl: "https://h/v1", imageBase: media(), videoBase: media(),
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("ProviderFactory", () => {
  it.each(["0", "1"])("uses the catalog mode for all model transports (globle=%s)", async globle => {
    vi.stubEnv("globle", globle);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: "test rejection" } }), {
        status: 403, headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetcher);
    const factory = new ProviderFactory({
      catalog: { ...catalog, defaultProvider: { ...catalog.defaultProvider, image: "happyhorse" } },
      llmBaseUrl: "https://h/v1", llmFetch: fetcher, imageBase: media(), videoBase: media(),
    });
    const messages = [{ role: "user" as const, content: "test" }];
    await expect(factory.llm("model", "user-key").chat(messages)[Symbol.asyncIterator]().next()).rejects.toThrow();
    await expect(factory.llm("model", "user-key", "responses").chat(messages)[Symbol.asyncIterator]().next()).rejects.toThrow();
    await expect(factory.image("gpt-image-2-token", "user-key").create({ prompt: "test" })).rejects.toThrow();
    await expect(factory.image("async-image", "user-key").create({ prompt: "test" })).rejects.toThrow();
    await expect(factory.video("veo3.1", "user-key").create({ prompt: "test" })).rejects.toThrow();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://h/v1/chat/completions", "https://h/v1/responses", "https://h/v1/images/generations",
      "https://h/v1/image/generations", "https://h/v1/video/generations",
    ]);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer user-key");
      expect(headers.get("X-Agent-Globle")).toBe(globle === "1" ? "1" : null);
    }
  });

  it("honors per-model Responses selection and a per-call override", () => {
    const factory = new ProviderFactory({ catalog: { ...catalog, llmProtocols: { "kimi-k3": "responses" } }, llmBaseUrl: "https://h/v1", imageBase: media(), videoBase: media() });
    expect(factory.llm("kimi-k3", "sk-u")).toBeInstanceOf(OpenAIResponsesProvider);
    expect(factory.llm("kimi-k3", "sk-u", "chat-completions")).toBeInstanceOf(OpenAIProvider);
  });
  it("llm → OpenAIProvider", () => {
    expect(f.llm("gpt-5.4", "sk-u")).toBeInstanceOf(OpenAIProvider);
  });
  it("image → OpenAIImagesImageProvider when adapter resolves to openai-images", () => {
    expect(f.image("gpt-image-2-token", "sk-u")).toBeInstanceOf(OpenAIImagesImageProvider);
  });
  it("video → HttpVideoGenerationProvider (happyhorse) with real key", () => {
    expect(f.video("veo3.1", "sk-u")).toBeInstanceOf(HttpVideoGenerationProvider);
  });
});
