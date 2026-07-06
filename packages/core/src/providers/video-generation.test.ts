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
  it("parsePoll surfaces a vendor error envelope (HTTP 200, no status) as failed", () => {
    // tokenhub returns errors as 200 with { code, message, data:null } and no
    // status field — must become a failure carrying the human-readable message,
    // not an empty status the client would coerce to "running" (infinite poll).
    const r = a.parsePoll({
      code: "fail_to_fetch_task",
      message: '{"error":{"message":"Failed to create video generation task: {\\"error\\":{\\"message\\":\\"当前账号处未订购seedance2.0模型资费包，或资费包已到期，请先订购后才能使用\\",\\"type\\":\\"invalid_authentication_error\\"}}","type":"proxy_error"}}',
      data: null,
    });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("未订购seedance2.0");
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
  it("create throws the clean vendor message when the endpoint returns HTTP 500", async () => {
    // The real tokenhub /video/generations response for an unsubscribed model:
    // HTTP 500 with a structured error envelope. The thrown error must be the
    // human-readable message, not a raw-JSON dump.
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () =>
        '{"code":"fail_to_fetch_task","message":"{\\"error\\":{\\"message\\":\\"Failed to create video generation task: {\\\\\\"error\\\\\\":{\\\\\\"message\\\\\\":\\\\\\"当前账号处未订购seedance2.0模型资费包，或资费包已到期，请先订购后才能使用\\\\\\",\\\\\\"type\\\\\\":\\\\\\"invalid_authentication_error\\\\\\"}}\\",\\"type\\":\\"proxy_error\\"}}","data":null}',
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpVideoGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseVideoAdapter(), model: "doubao-seedance-2.0" });
    await expect(p.create({ prompt: "小猫睡觉" })).rejects.toThrow(/未订购seedance2\.0/);
  });
  it("create throws instead of returning an empty task id when a 200 body has no task_id", async () => {
    // The real failure mode: /video/generations answers HTTP 200 with an error
    // envelope and no task_id. Returning taskId:"" (status "queued") would make
    // the job runner poll /videos/ forever; it must throw the vendor message.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: "fail_to_fetch_task", message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包"}}', data: null }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpVideoGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseVideoAdapter(), model: "vm" });
    await expect(p.create({ prompt: "小猫睡觉" })).rejects.toThrow(/未订购seedance2\.0/);
  });
  it("poll surfaces a 200 error envelope as failed instead of looping as 'running'", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: "fail_to_fetch_task", message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包"}}', data: null }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpVideoGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseVideoAdapter(), model: "vm" });
    const r = await p.poll("task_1");
    expect(r.status).toBe("failed");
    expect(r.error).toContain("未订购seedance2.0");
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
