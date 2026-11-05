import { describe, expect, it, vi } from "vitest";
import { requestTemperature } from "./model-params.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAIResponsesProvider } from "./responses.js";

describe("requestTemperature", () => {
  it("drops temperature only for models that fix it", () => {
    expect(requestTemperature("kimi-k3.1-pro", 0.2)).toBeUndefined();
    expect(requestTemperature("kimi-k3", 0.2)).toBe(0.2);
    expect(requestTemperature("deepseek-v4.1-flash", 0.2)).toBe(0.2);
    expect(requestTemperature("deepseek-v4.1-flash", undefined)).toBeUndefined();
  });
});

describe.each([
  ["Responses", OpenAIResponsesProvider],
  ["Chat Completions", OpenAIProvider],
])("%s request body", (_name, Provider) => {
  async function sentBody(model: string) {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      void init;
      return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
    });
    const provider = new Provider({ apiKey: "k", baseUrl: "http://gateway.test/v1", model, fetch: fetch as never });
    await (async () => {
      for await (const _chunk of provider.chat([{ role: "user", content: "hi" }], undefined, { params: { temperature: 0.2 } })) void _chunk;
    })().catch(() => {});
    return JSON.parse(String(fetch.mock.calls[0][1]?.body)) as Record<string, unknown>;
  }

  it("leaves temperature out for kimi-k3.1-pro", async () => {
    expect(await sentBody("kimi-k3.1-pro")).not.toHaveProperty("temperature");
  });

  it("keeps temperature for other models", async () => {
    expect((await sentBody("deepseek-v4.1-flash")).temperature).toBe(0.2);
  });
});
