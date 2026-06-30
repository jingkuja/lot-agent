import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HappyhorseImageAdapter,
  HttpImageGenerationProvider,
  MockImageGenerationProvider,
  pickImageAdapter,
} from "./image-generation.js";

describe("HappyhorseImageAdapter", () => {
  const a = new HappyhorseImageAdapter();
  it("builds image create/poll paths (singular create, plural poll)", () => {
    expect(a.createPath()).toBe("/image/generations");
    expect(a.pollPath("t1")).toBe("/images/t1");
  });
  it("buildCreateBody sends size + media, never duration/ratio/n/quality", () => {
    const body = a.buildCreateBody(
      { prompt: "菊花", size: "1024x1024", n: 2, quality: "hd", media: [{ type: "reference_image", url: "u" }] },
      "wanx-standard"
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "wanx-standard", prompt: "菊花", size: "1024x1024", media: [{ type: "reference_image", url: "u" }] });
    expect("duration" in body).toBe(false);
    expect("ratio" in body).toBe(false);
    expect("n" in body).toBe(false);
    expect("quality" in body).toBe(false);
    const noMedia = a.buildCreateBody({ prompt: "p" }, "m") as Record<string, unknown>;
    expect("media" in noMedia).toBe(false);
  });
  it("parseCreate/parsePoll/isTerminal", () => {
    expect(a.parseCreate({ id: "x", task_id: "task_9", status: "queued", progress: 0 })).toEqual({ taskId: "task_9", status: "queued", progress: 0 });
    expect(a.parsePoll({ status: "completed", progress: 100, metadata: { url: "https://x/y.png" } })).toEqual({ status: "completed", progress: 100, url: "https://x/y.png", error: undefined });
    expect(a.isTerminal("completed")).toBe("completed");
    expect(a.isTerminal("processing")).toBe(null);
  });
});

describe("HttpImageGenerationProvider", () => {
  afterEach(() => vi.restoreAllMocks());
  it("create POSTs the image create path with adapter body + Bearer", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ task_id: "task_1", status: "queued", progress: 0 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpImageGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseImageAdapter(), model: "im" });
    const r = await p.create({ prompt: "hi" });
    expect(r).toEqual({ taskId: "task_1", status: "queued", progress: 0 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api/v1/image/generations");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "im", prompt: "hi" });
  });
  it("poll GETs the image poll path and normalizes terminal status", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "completed", progress: 100, metadata: { url: "https://x/y.png" } }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpImageGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseImageAdapter(), model: "im" });
    const r = await p.poll("task_1");
    expect(r.status).toBe("completed");
    expect(r.url).toBe("https://x/y.png");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api/v1/images/task_1");
  });
  it("throws on non-ok create/poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch);
    const p = new HttpImageGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseImageAdapter(), model: "im" });
    await expect(p.create({ prompt: "x" })).rejects.toThrow(/500/);
    await expect(p.poll("t1")).rejects.toThrow(/500/);
  });
});

describe("MockImageGenerationProvider", () => {
  it("ramps progress then completes with a data: image url", async () => {
    let t = 0;
    const p = new MockImageGenerationProvider(1000, () => t);
    const created = await p.create({ prompt: "菊花" });
    expect(created.status).toBe("queued");
    t = 500;
    const mid = await p.poll(created.taskId);
    expect(mid.status).toBe("processing");
    expect(mid.progress).toBe(50);
    t = 1000;
    const done = await p.poll(created.taskId);
    expect(done.status).toBe("completed");
    expect(done.url?.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
  it("returns failed for an unknown task id", async () => {
    const p = new MockImageGenerationProvider(1000, () => 0);
    const r = await p.poll("does-not-exist");
    expect(r.status).toBe("failed");
  });
});

describe("pickImageAdapter", () => {
  it("returns Happyhorse for known + unknown names", () => {
    expect(pickImageAdapter("happyhorse")).toBeInstanceOf(HappyhorseImageAdapter);
    expect(pickImageAdapter("nope")).toBeInstanceOf(HappyhorseImageAdapter);
  });
});
