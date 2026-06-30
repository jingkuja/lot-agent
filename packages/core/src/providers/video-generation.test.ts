import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HappyhorseVideoAdapter,
  HttpVideoGenerationProvider,
  MockVideoGenerationProvider,
  pickVideoAdapter,
} from "./video-generation.js";

describe("HappyhorseVideoAdapter", () => {
  const a = new HappyhorseVideoAdapter();
  it("builds video create/poll paths (singular create, plural poll)", () => {
    expect(a.createPath()).toBe("/video/generations");
    expect(a.pollPath("t1")).toBe("/videos/t1");
  });
  it("buildCreateBody maps duration + includes media only when present", () => {
    const body = a.buildCreateBody(
      { prompt: "麦田", size: "832x480", durationSec: 5, ratio: "16:9", media: [{ type: "reference_image", url: "u" }] },
      "happyhorse-1.0-t2v"
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "happyhorse-1.0-t2v", prompt: "麦田", size: "832x480", duration: 5, ratio: "16:9", media: [{ type: "reference_image", url: "u" }] });
    const noMedia = a.buildCreateBody({ prompt: "p" }, "m") as Record<string, unknown>;
    expect("media" in noMedia).toBe(false);
    expect("duration" in noMedia).toBe(false);
  });
  it("parseCreate/parsePoll/isTerminal", () => {
    expect(a.parseCreate({ id: "x", task_id: "task_9", status: "queued", progress: 0 })).toEqual({ taskId: "task_9", status: "queued", progress: 0 });
    expect(a.parsePoll({ status: "completed", progress: 100, metadata: { url: "https://x/y.mp4" } })).toEqual({ status: "completed", progress: 100, url: "https://x/y.mp4", error: undefined });
    expect(a.isTerminal("failed")).toBe("failed");
    expect(a.isTerminal("processing")).toBe(null);
  });
});

describe("HttpVideoGenerationProvider", () => {
  afterEach(() => vi.restoreAllMocks());
  it("create POSTs the video create path with adapter body + Bearer", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ task_id: "task_1", status: "queued", progress: 0 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpVideoGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseVideoAdapter(), model: "vm" });
    const r = await p.create({ prompt: "hi" });
    expect(r).toEqual({ taskId: "task_1", status: "queued", progress: 0 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api/v1/video/generations");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "vm", prompt: "hi" });
  });
  it("poll GETs the video poll path", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "completed", progress: 100, metadata: { url: "https://x/y.mp4" } }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpVideoGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseVideoAdapter(), model: "vm" });
    const r = await p.poll("task_1");
    expect(r.status).toBe("completed");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api/v1/videos/task_1");
  });
});

describe("MockVideoGenerationProvider", () => {
  it("fails when prompt contains 'fail' past the halfway mark", async () => {
    let t = 0;
    const p = new MockVideoGenerationProvider(1000, () => t);
    const c = await p.create({ prompt: "please fail" });
    t = 600;
    const r = await p.poll(c.taskId);
    expect(r.status).toBe("failed");
  });
});

describe("pickVideoAdapter", () => {
  it("returns Happyhorse for known + unknown names", () => {
    expect(pickVideoAdapter("happyhorse")).toBeInstanceOf(HappyhorseVideoAdapter);
    expect(pickVideoAdapter("nope")).toBeInstanceOf(HappyhorseVideoAdapter);
  });
});
