import { describe, it, expect, vi, afterEach } from "vitest";
import { MockImageProvider, OpenAIImageProvider } from "./image.js";

describe("MockImageProvider", () => {
  it("returns OpenAI-shaped result with a data: url", async () => {
    const r = await new MockImageProvider().generate({ prompt: "菊花", size: "1024x1024" });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(typeof r.created).toBe("number");
  });

  it("honors n by returning n images", async () => {
    const r = await new MockImageProvider().generate({ prompt: "x", n: 3 });
    expect(r.data).toHaveLength(3);
  });

  it("throws when the prompt contains 'fail' (demo failure path)", async () => {
    await expect(new MockImageProvider().generate({ prompt: "please fail" })).rejects.toThrow();
  });
});

describe("OpenAIImageProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the OpenAI body and parses data[].url", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ created: 1, data: [{ url: "https://x/y.png" }], usage: { total_tokens: 0 } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const p = new OpenAIImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    const r = await p.generate({ prompt: "hi", size: "1024x1024", n: 1 });

    expect(r.data[0].url).toBe("https://x/y.png");
    const [url, init] = (fetchMock as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe("https://api/v1/images/generations");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "m", prompt: "hi", size: "1024x1024", n: 1, response_format: "url" });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch);
    const p = new OpenAIImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    await expect(p.generate({ prompt: "hi" })).rejects.toThrow(/500/);
  });
});
