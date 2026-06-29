import { describe, it, expect, vi, afterEach } from "vitest";
import { MockVideoProvider, OpenAIVideoProvider } from "./video.js";

describe("MockVideoProvider", () => {
  it("returns a poster data url and echoes duration", async () => {
    const r = await new MockVideoProvider().generate({ prompt: "麦田", durationSec: 10, size: "832x480" });
    expect(r.data[0].url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(r.durationSec).toBe(10);
  });
  it("throws when prompt contains 'fail'", async () => {
    await expect(new MockVideoProvider().generate({ prompt: "fail" })).rejects.toThrow();
  });
});

describe("OpenAIVideoProvider", () => {
  afterEach(() => vi.restoreAllMocks());
  it("POSTs to /video/generations with model + prompt", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ created: 1, data: [{ url: "https://x/y.mp4" }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAIVideoProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "happyhorse-1.0-t2v" });
    const r = await p.generate({ prompt: "麦田", durationSec: 5, size: "832x480", ratio: "16:9" });
    expect(r.data[0].url).toBe("https://x/y.mp4");
    const [url, init] = (fetchMock as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe("https://api/v1/video/generations");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "happyhorse-1.0-t2v", prompt: "麦田", size: "832x480", duration: 5, ratio: "16:9" });
  });
});
