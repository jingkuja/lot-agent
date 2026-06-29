import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HappyhorseAdapter,
  HttpGenerationProvider,
  MockGenerationProvider,
  pickAdapter,
} from "./generation.js";

describe("HappyhorseAdapter", () => {
  const a = new HappyhorseAdapter();
  it("builds create/poll paths (singular create, plural poll)", () => {
    expect(a.createPath("image")).toBe("/image/generations");
    expect(a.createPath("video")).toBe("/video/generations");
    expect(a.pollPath("image", "t1")).toBe("/images/t1");
    expect(a.pollPath("video", "t1")).toBe("/videos/t1");
  });
  it("buildCreateBody maps duration + includes media only when present", () => {
    const body = a.buildCreateBody(
      { mediaType: "video", prompt: "麦田", size: "832x480", durationSec: 5, ratio: "16:9", media: [{ type: "reference_image", url: "u" }] },
      "happyhorse-1.0-t2v"
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "happyhorse-1.0-t2v", prompt: "麦田", size: "832x480", duration: 5, ratio: "16:9", media: [{ type: "reference_image", url: "u" }] });
    const noMedia = a.buildCreateBody({ mediaType: "image", prompt: "p" }, "m") as Record<string, unknown>;
    expect("media" in noMedia).toBe(false);
  });
  it("parseCreate reads task_id/status/progress", () => {
    expect(a.parseCreate({ id: "x", task_id: "task_9", status: "queued", progress: 0 })).toEqual({ taskId: "task_9", status: "queued", progress: 0 });
  });
  it("parsePoll reads status/progress/metadata.url", () => {
    expect(a.parsePoll({ status: "completed", progress: 100, metadata: { url: "https://x/y.mp4" } })).toEqual({ status: "completed", progress: 100, url: "https://x/y.mp4", error: undefined });
  });
  it("isTerminal classifies completed/failed/other", () => {
    expect(a.isTerminal("completed")).toBe("completed");
    expect(a.isTerminal("failed")).toBe("failed");
    expect(a.isTerminal("processing")).toBe(null);
  });
});

describe("HttpGenerationProvider", () => {
  afterEach(() => vi.restoreAllMocks());
  it("create POSTs createPath with adapter body + Bearer", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ task_id: "task_1", status: "queued", progress: 0 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseAdapter(), imageModel: "im", videoModel: "vm" });
    const r = await p.create({ mediaType: "video", prompt: "hi" });
    expect(r).toEqual({ taskId: "task_1", status: "queued", progress: 0 });
    const [url, init] = (fetchMock.mock.calls[0] as [string, RequestInit]);
    expect(url).toBe("https://api/v1/video/generations");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "vm", prompt: "hi" });
  });
  it("poll GETs pollPath and normalizes terminal status", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "completed", progress: 100, metadata: { url: "https://x/y.png" } }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseAdapter(), imageModel: "im", videoModel: "vm" });
    const r = await p.poll("task_1", "image");
    expect(r.status).toBe("completed");
    expect(r.url).toBe("https://x/y.png");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api/v1/images/task_1");
  });
  it("create throws on non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch);
    const p = new HttpGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseAdapter(), imageModel: "im", videoModel: "vm" });
    await expect(p.create({ mediaType: "image", prompt: "x" })).rejects.toThrow(/500/);
  });
  it("poll throws on non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, text: async () => "bad" })) as unknown as typeof fetch);
    const p = new HttpGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseAdapter(), imageModel: "im", videoModel: "vm" });
    await expect(p.poll("t1", "image")).rejects.toThrow(/502/);
  });
});

describe("MockGenerationProvider", () => {
  it("ramps progress then completes with a data: url", async () => {
    let t = 0;
    const p = new MockGenerationProvider(1000, () => t);
    const created = await p.create({ mediaType: "image", prompt: "菊花" });
    expect(created.status).toBe("queued");
    t = 500;
    const mid = await p.poll(created.taskId, "image");
    expect(mid.status).toBe("processing");
    expect(mid.progress).toBe(50);
    t = 1000;
    const done = await p.poll(created.taskId, "image");
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(100);
    expect(done.url?.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
  it("fails when prompt contains 'fail' past the halfway mark", async () => {
    let t = 0;
    const p = new MockGenerationProvider(1000, () => t);
    const c = await p.create({ mediaType: "video", prompt: "please fail" });
    t = 600;
    const r = await p.poll(c.taskId, "video");
    expect(r.status).toBe("failed");
  });
  it("returns failed for an unknown task id", async () => {
    const p = new MockGenerationProvider(1000, () => 0);
    const r = await p.poll("does-not-exist", "image");
    expect(r.status).toBe("failed");
    expect(r.error).toBeTruthy();
  });
});

describe("pickAdapter", () => {
  it("returns Happyhorse for known + unknown names", () => {
    expect(pickAdapter("happyhorse")).toBeInstanceOf(HappyhorseAdapter);
    expect(pickAdapter("nope")).toBeInstanceOf(HappyhorseAdapter);
  });
});
