import { afterEach, describe, expect, it, vi } from "vitest";
import { extractImageUrls, normalizeImageSize, OpenAIImagesImageProvider } from "./openai-images-image.js";

describe("extractImageUrls", () => {
  it("uses response URLs directly", () => {
    expect(extractImageUrls({ data: [{ url: "https://images.example/cat.png" }] })).toEqual([
      "https://images.example/cat.png",
    ]);
  });

  it("turns b64_json responses into PNG data URLs", () => {
    expect(extractImageUrls({ data: [{ b64_json: "aGVsbG8=" }] })).toEqual([
      "data:image/png;base64,aGVsbG8=",
    ]);
  });

  it("keeps every returned image and ignores malformed entries", () => {
    expect(extractImageUrls({ data: [null, {}, { url: "https://x/a.png" }, { b64_json: "YmJi" }] })).toEqual([
      "https://x/a.png",
      "data:image/png;base64,YmJi",
    ]);
  });
});

describe("normalizeImageSize", () => {
  it("defaults to the highest standard square resolution", () => {
    expect(normalizeImageSize()).toBe("1024x1024");
    expect(normalizeImageSize("invalid")).toBe("1024x1024");
  });

  it("caps the longest edge at 1024 while preserving the ratio", () => {
    expect(normalizeImageSize("2048x2048")).toBe("1024x1024");
    expect(normalizeImageSize("2048x1152")).toBe("1024x576");
    expect(normalizeImageSize("768x1024")).toBe("768x1024");
  });
});

describe("OpenAIImagesImageProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  const okResponse = (data: unknown) => ({ ok: true, text: async () => JSON.stringify(data) });

  it("uses /images/generations for text-only requests", async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [{ url: "https://x/y.png" }] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "gpt-image-2" });

    await provider.create({ prompt: "生成一只猫", size: "1024x1024", n: 1, quality: "high" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api/v1/images/generations");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer k", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2",
      prompt: "生成一只猫",
      size: "1024x1024",
      n: 1,
      quality: "high",
    });
  });

  it("caps a stale 2048px request to 1024px before sending it to Tokenhub", async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [{ url: "https://x/y.png" }] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "gpt-image-2" });

    await provider.create({ prompt: "生成一只猫", size: "2048x2048" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).size).toBe("1024x1024");
  });

  it("uses /images/edits and sends even a single reference as Tokenhub's image array", async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [{ url: "https://x/y.png" }] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "gpt-image-2" });

    await provider.create({
      prompt: "改成水彩画",
      size: "1024x1024",
      n: 1,
      media: [{ type: "reference_image", url: "data:image/png;base64,YQ==" }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api/v1/images/edits");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2",
      image: ["data:image/png;base64,YQ=="],
      prompt: "改成水彩画",
      size: "1024x1024",
      n: 1,
    });
  });

  it("sends two reference images as Tokenhub's image array", async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [{ url: "https://x/y.png" }] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "gpt-image-2" });

    await provider.create({
      prompt: "以第一张图为主体，参考第二张图的水彩风格",
      size: "1024x1024",
      n: 1,
      media: [
        { type: "reference_image", url: "data:image/jpeg;base64,YQ==" },
        { type: "reference_image", url: "data:image/png;base64,Yg==" },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api/v1/images/edits");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2",
      image: ["data:image/jpeg;base64,YQ==", "data:image/png;base64,Yg=="],
      prompt: "以第一张图为主体，参考第二张图的水彩风格",
      size: "1024x1024",
      n: 1,
    });
  });

  it("sends five reference images as Tokenhub's image array", async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [{ url: "https://x/y.png" }] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "gpt-image-2" });
    const media = Array.from({ length: 5 }, (_, i) => ({
      type: "reference_image" as const,
      url: `data:image/png;base64,${i}`,
    }));

    await provider.create({ prompt: "改图", media });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).image).toEqual(media.map((item) => item.url));
  });

  it("rejects more than five reference images instead of silently dropping extras", async () => {
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "gpt-image-2" });
    await expect(provider.create({
      prompt: "改图",
      media: Array.from({ length: 6 }, (_, i) => ({
        type: "reference_image" as const,
        url: `data:image/png;base64,${i}`,
      })),
    })).rejects.toThrow(/at most 5 reference images/i);
  });

  it("returns b64_json output as a data URL for the existing server-side downloader", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ data: [{ b64_json: "aGVsbG8=" }] })) as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });

    const created = await provider.create({ prompt: "cat" });
    const result = await provider.poll(created.taskId);

    expect(result).toMatchObject({
      status: "completed",
      progress: 100,
      url: "data:image/png;base64,aGVsbG8=",
      urls: ["data:image/png;base64,aGVsbG8="],
    });
  });

  it("fails clearly when the response has no URL or b64_json", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ data: [{}] })) as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    await expect(provider.create({ prompt: "cat" })).rejects.toThrow(/no image url or b64_json/i);
  });

  it("surfaces non-success response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch);
    const provider = new OpenAIImagesImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    await expect(provider.create({ prompt: "cat" })).rejects.toThrow(/500 boom/);
  });
});
