import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HappyhorseVideoAdapter,
  OpenaiVideoAdapter,
  HttpVideoGenerationProvider,
  MockVideoGenerationProvider,
  pickVideoAdapter,
  usesSeedanceReferenceVideoAdaptive,
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
    expect(body).toMatchObject({ model: "happyhorse-1.0-t2v", prompt: "麦田", size: "832x480", duration: 5, ratio: "16:9", generate_audio: false, media: [{ type: "reference_image", url: "u" }] });
    const noMedia = a.buildCreateBody({ prompt: "p" }, "m") as Record<string, unknown>;
    expect("media" in noMedia).toBe(false);
    expect("duration" in noMedia).toBe(false);
    expect(noMedia.generate_audio).toBe(false);
  });
  it("forces generated audio on when a reference audio is present", () => {
    const body = a.buildCreateBody({ prompt: "p", generate_audio: false, reference_audio: "https://x/ref.mp3" }, "m") as Record<string, unknown>;
    expect(body.generate_audio).toBe(true);
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

describe("OpenaiVideoAdapter", () => {
  const a = new OpenaiVideoAdapter();
  it("uses the OpenAI-style create path but the shared plural poll path", () => {
    expect(a.createPath()).toBe("/videos");
    expect(a.pollPath("t1")).toBe("/videos/t1");
  });
  it("buildCreateBody sends seconds (string) + size, not duration/ratio", () => {
    const body = a.buildCreateBody(
      { prompt: "A cinematic drone shot", size: "720x1280", durationSec: 4, ratio: "9:16" },
      "doubao-seedance-2.0"
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "doubao-seedance-2.0", prompt: "A cinematic drone shot", seconds: "4", size: "720x1280", generate_audio: false });
    expect("duration" in body).toBe(false);
    expect("ratio" in body).toBe(false);
  });
  it("seedance + reference video forces duration -1 and ratio adaptive", () => {
    const body = a.buildCreateBody(
      {
        prompt: "follow this clip",
        size: "720x1280",
        durationSec: 5,
        ratio: "9:16",
        reference_video: "https://x/ref.mp4",
      },
      "doubao-seedance-2.0"
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "doubao-seedance-2.0",
      prompt: "follow this clip",
      duration: -1,
      ratio: "adaptive",
      size: "720x1280",
      reference_video: "https://x/ref.mp4",
    });
    expect("seconds" in body).toBe(false);
  });
  it("does not force adaptive duration/ratio for non-seedance models with a reference video", () => {
    const body = a.buildCreateBody(
      {
        prompt: "follow this clip",
        size: "720x1280",
        durationSec: 5,
        ratio: "9:16",
        reference_video: "https://x/ref.mp4",
      },
      "kling-standard"
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ seconds: "5", size: "720x1280" });
    expect(body.duration).toBeUndefined();
    expect(body.ratio).toBeUndefined();
  });
  it("sends multiple reference inputs plus first/last frames", () => {
    const body = a.buildCreateBody({
      prompt: "p",
      input_reference: ["https://x/ref-a.png", "https://x/ref-b.png"],
      reference_video: ["https://x/ref-a.mp4", "https://x/ref-b.mp4"],
      reference_audio: ["https://x/ref-a.mp3"],
      first_frame: "https://x/first.png",
      last_frame: "https://x/last.png",
    }, "m") as Record<string, unknown>;
    expect(body).toMatchObject({
      input_reference: ["https://x/ref-a.png", "https://x/ref-b.png"],
      reference_video: ["https://x/ref-a.mp4", "https://x/ref-b.mp4"],
      reference_audio: ["https://x/ref-a.mp3"],
      first_frame: "https://x/first.png",
      last_frame: "https://x/last.png",
    });
    expect("media" in body).toBe(false);
    expect("seconds" in body).toBe(false);
  });
  it("keeps backwards compatibility with legacy media reference images", () => {
    const body = a.buildCreateBody({ prompt: "p", media: [
      { type: "reference_image", url: "https://x/ref-a.png" },
      { type: "reference_image", url: "https://x/ref-b.png" },
    ] }, "m") as Record<string, unknown>;
    expect(body.input_reference).toEqual(["https://x/ref-a.png", "https://x/ref-b.png"]);
    expect("media" in body).toBe(false);
  });
  it("omits input_reference when no reference image is present", () => {
    const body = a.buildCreateBody({ prompt: "p" }, "m") as Record<string, unknown>;
    expect("input_reference" in body).toBe(false);
  });
  it("reuses the shared create/poll/terminal parsing", () => {
    expect(a.parseCreate({ id: "x", task_id: "task_9", status: "queued", progress: 0 })).toEqual({ taskId: "task_9", status: "queued", progress: 0 });
    expect(a.parsePoll({ status: "completed", progress: 100, metadata: { url: "http://x/y.mp4" } })).toEqual({ status: "completed", progress: 100, url: "http://x/y.mp4", error: undefined });
    expect(a.isTerminal("completed")).toBe("completed");
    expect(a.isTerminal("queued")).toBe(null);
  });
  it("does not accept id as a fallback when task_id is missing", () => {
    expect(a.parseCreate({ id: "task_9", status: "queued", progress: 0 })).toEqual({
      taskId: "",
      status: "queued",
      progress: 0,
    });
  });
});

describe("HttpVideoGenerationProvider", () => {
  afterEach(() => vi.restoreAllMocks());
  it("create POSTs the video create path with adapter body + Bearer", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ task_id: "task_1", status: "queued", progress: 0 }) }));
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
      text: async () => JSON.stringify({ code: "fail_to_fetch_task", message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包"}}', data: null }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpVideoGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseVideoAdapter(), model: "vm" });
    await expect(p.create({ prompt: "小猫睡觉" })).rejects.toThrow(/未订购seedance2\.0/);
  });
  it("openai-video fails with the raw response when only id is returned", async () => {
    const rawBody = JSON.stringify({ id: "task_1", object: "video", status: "queued", progress: 0 });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => rawBody,
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpVideoGenerationProvider({
      baseUrl: "https://api/v1",
      apiKey: "k",
      adapter: new OpenaiVideoAdapter(),
      model: "doubao-seedance-2.0",
    });

    await expect(
      p.create({ prompt: "小狗睡觉。", durationSec: 4, size: "720x1280" })
    ).rejects.toThrow(rawBody);
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

describe("usesSeedanceReferenceVideoAdaptive", () => {
  it("is true only for seedance models with a reference video", () => {
    expect(usesSeedanceReferenceVideoAdaptive("doubao-seedance-2.0", "https://x/r.mp4")).toBe(true);
    expect(usesSeedanceReferenceVideoAdaptive("Seedance-2.0", ["https://x/r.mp4"])).toBe(true);
    expect(usesSeedanceReferenceVideoAdaptive("doubao-seedance-2.0", [])).toBe(false);
    expect(usesSeedanceReferenceVideoAdaptive("doubao-seedance-2.0", undefined)).toBe(false);
    expect(usesSeedanceReferenceVideoAdaptive("kling-standard", "https://x/r.mp4")).toBe(false);
  });
});

describe("pickVideoAdapter", () => {
  it("returns the openai-video adapter for its name", () => {
    expect(pickVideoAdapter("openai-video")).toBeInstanceOf(OpenaiVideoAdapter);
  });
  it("returns Happyhorse for the happyhorse name + unknown names", () => {
    expect(pickVideoAdapter("happyhorse")).toBeInstanceOf(HappyhorseVideoAdapter);
    expect(pickVideoAdapter("nope")).toBeInstanceOf(HappyhorseVideoAdapter);
  });
});
