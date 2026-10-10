import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpKlingVoiceProvider } from "./kling-voices.js";

const taskId = "917124237444943953";
const voiceId = "917124264959582304";
const provider = () => new HttpKlingVoiceProvider({ baseUrl: "https://gateway.example/v1/", apiKey: "user-key" });
const envelope = (status: string, voices?: unknown) => ({ code: 0, data: { task_id: taskId, task_status: status, task_result: { voices } } });
afterEach(() => vi.unstubAllGlobals());

describe("Kling custom voice HTTP contract", () => {
  it("creates then queries and preserves long voice IDs exactly", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(envelope("submitted")))
      .mockResolvedValueOnce(Response.json(envelope("succeed", [{ voice_id: voiceId, status: "succeed" }])));
    vi.stubGlobal("fetch", fetcher);
    const client = provider();
    expect(await client.create({ voiceName: "sample", voiceUrl: "https://media.example/voice.wav", externalTaskId: "external-1" }))
      .toEqual({ taskId, status: "submitted", voiceId: undefined });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("https://gateway.example/v1/wand/kling/custom-voices");
    expect(request).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer user-key" } });
    expect(JSON.parse(request.body)).toEqual({ voice_name: "sample", voice_url: "https://media.example/voice.wav", external_task_id: "external-1" });
    expect(await client.poll(taskId)).toEqual({ taskId, status: "succeed", voiceId });
    expect(fetcher.mock.calls[1][0]).toBe(`https://gateway.example/v1/wand/kling/custom-voices/${taskId}`);
    expect(fetcher.mock.calls[1][1].method).toBe("GET");
  });

  it.each([
    null,
    { code: 1, message: "secret vendor diagnostics" },
    { code: 0, data: { task_id: 917124237444943953, task_status: "submitted" } },
    envelope("succeeded"),
    envelope("succeed", [{ voice_id: 917124264959582304 }]),
    envelope("succeed", [{ voice_id: voiceId, status: "deleted" }]),
    envelope("succeed", [null]),
    envelope("succeed", [{ voice_id: "1" }, { voice_id: "2" }]),
  ])("rejects malformed/failed results without using task IDs as voice IDs (%j)", async (body) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider().poll(taskId)).rejects.toThrow(/Kling/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not expose voice IDs before the task succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(envelope("processing", [{ voice_id: voiceId }]))));
    expect((await provider().poll(taskId)).voiceId).toBeUndefined();
  });

  it("does not retry a POST after an uncertain network outcome", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("connection lost"));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider().create({ voiceName: "sample", voiceUrl: "https://media.example/a.wav", externalTaskId: "e1" })).rejects.toThrow("connection lost");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("aborts in-flight fetch when the job is cancelled", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = provider().poll(taskId, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe("Kling voice failure diagnostics", () => {
  it("surfaces HTTP 400 validation details, business code and request ID without retrying", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 1201, message: "voice_name exceeds maximum length", request_id: "req-400" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider().create({ voiceName: "sample", voiceUrl: "https://media.example/a.wav", externalTaskId: "e1" }))
      .rejects.toThrow("HTTP 400，code: 1201，request_id: req-400）：voice_name exceeds maximum length");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("redacts API keys, bearer credentials and signed audio URLs from diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      code: 1201, message: 'invalid key user-key; Authorization: Bearer another-secret; source https://media.example/a.wav?token=private', request_id: "req-1",
    }, { status: 400 })));
    let message = "";
    try { await provider().poll("t1"); } catch (err) { message = (err as Error).message; }
    expect(message).toContain("invalid key [redacted]");
    expect(message).toContain("[url]");
    expect(message).not.toMatch(/user-key|another-secret|token=private|media\.example/);
  });

  it("handles non-JSON gateway errors without exposing HTML or throwing a parse error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('<html>internal gateway debug</html>', { status: 502 })));
    await expect(provider().poll("t1")).rejects.toThrow("Kling 音色接口请求失败（HTTP 502）");
  });

  it("preserves an upstream task failure reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 0, data: { task_id: taskId, task_status: "failed", task_status_msg: "audio contains no clear speech" } })));
    expect(await provider().poll(taskId)).toMatchObject({ status: "failed", error: "audio contains no clear speech" });
  });

  it("also surfaces vendor validation errors delivered with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 1201, message: "invalid audio format", request_id: "req-2" })));
    await expect(provider().poll(taskId)).rejects.toThrow("invalid audio format");
  });
});
