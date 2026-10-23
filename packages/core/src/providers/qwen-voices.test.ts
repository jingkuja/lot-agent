import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpQwenVoiceProvider, isQwenCreateRejected, QwenVoiceError } from "./qwen-voices.js";

const model = "qwen-audio-3.0-tts-flash";
const voiceId = `${model}-abc123-unique`;
const client = () => new HttpQwenVoiceProvider({ baseUrl: "https://qwen.example/api/v1/", apiKey: "private-key", targetModel: model });
afterEach(() => vi.unstubAllGlobals());
describe("Qwen enrollment HTTP contract", () => {
  it("creates, queries and finds voices with the documented POST actions", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ output: { voice_id: voiceId } }))
      .mockResolvedValueOnce(Response.json({ output: { target_model: model, status: "OK", resource_link: "https://private.example" } }))
      .mockResolvedValueOnce(Response.json({ output: { voice_list: [{ voice_id: voiceId, status: "DEPLOYING" }] } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await client().create({ url: "https://sample.example/a.wav?private=token", prefix: "abc123" })).toBe(voiceId);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://qwen.example/api/v1/services/audio/tts/customization");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer private-key" } });
    expect(JSON.parse(init.body)).toEqual({ model: "voice-enrollment", input: { action: "create_voice", url: "https://sample.example/a.wav?private=token", target_model: model, prefix: "abc123" } });
    expect(await client().query(voiceId)).toEqual({ voiceId, status: "OK" });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).input).toEqual({ action: "query_voice", voice_id: voiceId });
    expect(await client().find("abc123")).toEqual({ voiceId, status: "DEPLOYING" });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).input).toEqual({ action: "list_voice", prefix: "abc123", page_index: 0, page_size: 100 });
  });
  it.each([null, {}, { output: { voice_id: "wrong-model-abc123-id" } }, { output: { voice_id: 123 } }])("rejects malformed creation output (%j) without vendor text", async body => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body)); vi.stubGlobal("fetch", fetcher);
    await expect(client().create({ url: "https://a.example", prefix: "abc123" })).rejects.toThrow("INVALID_RESPONSE");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    [Response.json({ code: "InvalidParameter", message: "private-key" }), true],
    [Response.json({ code: "InvalidParameter", message: "download failed" }, { status: 400 }), true],
    [Response.json({ code: "Throttling" }, { status: 429 }), true],
    [new Response("timeout", { status: 408 }), false],
    [new Response("bad gateway", { status: 502 }), false],
    [Response.json({ output: { voice_id: "wrong-model-abc123-id" } }), false],
  ])("classifies only explicit create refusals as rejected (%#)", async (response, rejected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await client().create({ url: "https://a.example", prefix: "abc123" }).catch(e => e as Error) as Error;
    expect(isQwenCreateRejected(error)).toBe(rejected); expect(error.message).not.toContain("private-key");
  });
  it("never treats transport failures or read-only phases as refusals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("reset")).mockResolvedValueOnce(Response.json({ code: "x" }, { status: 400 })));
    expect(isQwenCreateRejected(await client().create({ url: "https://a.example", prefix: "abc123" }).catch(e => e))).toBe(false);
    expect(isQwenCreateRejected(await client().query(voiceId).catch(e => e))).toBe(false);
  });
  it("never retries uncertain writes or exposes credentials and source URLs", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("private-key https://private.example")); vi.stubGlobal("fetch", fetcher);
    let error: Error | undefined;
    try { await client().create({ url: "https://a.example", prefix: "abc123" }); } catch (e) { error = e as Error; }
    expect(error?.message).toContain("TRANSPORT_ERROR");
    expect(error?.message).not.toMatch(/private-key|https:/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects a target-model mismatch even when status is OK", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ output: { status: "OK", target_model: "another-model" } })));
    await expect(client().query(voiceId)).rejects.toThrow("INVALID_RESPONSE");
  });
  it("does not adopt voices matching only a partial prefix", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ output: { voice_list: [{ voice_id: `${model}-abc1234-id`, status: "OK" }] } })));
    expect(await client().find("abc123")).toBeNull();
  });
  it("rejects ambiguous recovery results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ output: { voice_list: ["one", "two"].map(id => ({ voice_id: `${model}-abc123-${id}`, status: "OK" })) } })));
    await expect(client().find("abc123")).rejects.toThrow("INVALID_RESPONSE");
  });
  it("retains safe HTTP diagnostics and rejects non-JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private gateway details", { status: 502 })));
    await expect(client().query(voiceId)).rejects.toThrow("HTTP 502");
  });
  it("preserves allowlisted rejection codes and upstream request IDs without vendor text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      code: "BadRequest.InputDownloadFailed",
      message: "private-key https://sample.example/a.wav?private=token",
      request_id: "req-abcdef123456",
    }, { status: 400 })));
    const error = await client().create({ url: "https://sample.example/a.wav?private=token", prefix: "abc123" }).catch(e => e);
    expect(error).toBeInstanceOf(QwenVoiceError);
    expect(error).toMatchObject({ vendorCode: "BadRequest.InputDownloadFailed", requestId: "req-abcdef123456", httpStatus: 400 });
    expect(JSON.stringify(error) + error.message).not.toMatch(/private-key|sample.example|private=token/);
  });
  it("drops unknown or credential-valued codes and uses safe header request IDs for non-JSON errors", async () => {
    for (const vendorCode of ["private-key", "PrivateUserContent", "https://private.example", "Audio.PreprocessError"]) {
      const error = new QwenVoiceError("create", "HTTP_ERROR", { vendorCode, privateValues: ["Audio.PreprocessError"] });
      expect(error.vendorCode).toBeUndefined();
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private details", {
      status: 403, headers: { "x-request-id": "req-abcdef123456" },
    })));
    await expect(client().create({ url: "https://a.example", prefix: "abc123" })).rejects.toMatchObject({
      requestId: "req-abcdef123456", httpStatus: 403, vendorCode: undefined,
    });
  });
  it("passes cancellation to the request and does not start an already cancelled call", async () => {
    const abort = new AbortController(); abort.abort(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(client().create({ url: "https://a.example", prefix: "abc123" }, abort.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
