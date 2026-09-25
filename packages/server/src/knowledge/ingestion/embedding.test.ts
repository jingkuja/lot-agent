import { expect, it, vi } from "vitest";
import { TokenhubEmbeddingProvider } from "./embedding.js";
const payload = { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 6, total_tokens: 6 } };
it("orders by response index, records actual usage and binds the caller key", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload)); const usage = vi.fn(async () => {});
  const provider = new TokenhubEmbeddingProvider({ baseUrl: "https://gateway/v1", apiKey: "caller-key", model: "qwen3.7-text-embedding", dimensions: 2, onUsage: usage, fetcher });
  expect(await provider.embed(["a", "b"])).toEqual([[1, 0], [0, 1]]);
  expect(usage).toHaveBeenCalledWith(6, undefined);
  expect((fetcher.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer caller-key");
});
it("meters malformed paid responses before rejecting missing/duplicate/zero vectors", async () => {
  for (const data of [[{ index: 0, embedding: [1, 0] }], [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }], [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [1, 0] }]]) {
    const usage = vi.fn(async () => {});
    const provider = new TokenhubEmbeddingProvider({ baseUrl: "https://gateway/v1", apiKey: "key", model: "model", dimensions: 2, onUsage: usage, fetcher: async () => Response.json({ ...payload, data }) });
    await expect(provider.embed(["a", "b"])).rejects.toThrow("INVALID_EMBEDDING_RESPONSE");
    expect(usage).toHaveBeenCalledWith(6, undefined);
  }
});
it("does not expose upstream messages or accept a missing user key", async () => {
  expect(() => new TokenhubEmbeddingProvider({ baseUrl: "https://gateway/v1", apiKey: "", model: "m", dimensions: 2, onUsage: async () => {} })).toThrow();
  const provider = new TokenhubEmbeddingProvider({ baseUrl: "https://gateway/v1", apiKey: "key", model: "m", dimensions: 2, onUsage: async () => {}, fetcher: async () => new Response("secret provider text", { status: 429 }) });
  await expect(provider.embed(["a"])).rejects.toThrow("EMBEDDING_RATE_LIMITED");
});
it.each([
  [401, "EMBEDDING_AUTH_FAILED", false],
  [403, "EMBEDDING_ACCESS_DENIED", false],
  [404, "EMBEDDING_MODEL_UNAVAILABLE", false],
  [400, "EMBEDDING_INVALID_REQUEST", false],
  [429, "EMBEDDING_RATE_LIMITED", true],
  [503, "EMBEDDING_PROVIDER_UNAVAILABLE", true],
])("classifies HTTP %s without exposing credentials or billing a rejected call", async (status, code, retryable) => {
  const usage = vi.fn(async () => {});
  const provider = new TokenhubEmbeddingProvider({ baseUrl: "https://gateway/v1", apiKey: "key", model: "model", dimensions: 2, onUsage: usage,
    fetcher: async () => new Response("private upstream API key details", { status }) });
  await expect(provider.embed(["test"])).rejects.toMatchObject({ message: code, retryable });
  expect(usage).not.toHaveBeenCalled();
});
