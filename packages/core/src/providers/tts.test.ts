import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISpeechProvider } from "./tts.js";

const client = (maxBytes?: number) => new OpenAISpeechProvider({ baseUrl: "https://gateway.example/v1/", apiKey: "private-key", maxBytes });
const request = { model: "qwen-audio-3.0-tts-plus", text: "你好", voice: "qwen-audio-3.0-tts-plus-abc-1", speed: 1.2, instructions: "温柔" };
const audio = (body: ConstructorParameters<typeof Response>[0], type = "audio/mpeg", status = 200) => new Response(body, { status, headers: { "Content-Type": type } });
afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible speech synthesis", () => {
  it("posts the documented New API body and returns audio bytes", async () => {
    const fetcher = vi.fn().mockResolvedValue(audio(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetcher);
    expect(await client().synthesize(request)).toEqual({ audio: new Uint8Array([1, 2, 3]), mime: "audio/mpeg" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://gateway.example/v1/audio/speech");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer private-key" } });
    expect(JSON.parse(init.body)).toEqual({ model: request.model, input: "你好", voice: request.voice, response_format: "mp3", speed: 1.2, instructions: "温柔" });
  });
  it.each([
    [audio(JSON.stringify({ error: { message: "private-key quota" } }), "application/json", 403), "HTTP_ERROR"],
    [audio("{}", "application/json"), "INVALID_RESPONSE"],
    [audio(new Uint8Array()), "INVALID_RESPONSE"],
  ])("rejects failures without vendor text (%#)", async (response, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await client().synthesize(request).catch(e => e as Error) as Error;
    expect(error.message).toContain(code); expect(error.message).not.toContain("private-key");
  });
  it("caps the downloaded size", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audio(new Uint8Array(10))));
    await expect(client(5).synthesize(request)).rejects.toThrow("INVALID_RESPONSE");
  });
  it("never retries a billed request after a lost response", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("private-key reset")); vi.stubGlobal("fetch", fetcher);
    const error = await client().synthesize(request).catch(e => e as Error) as Error;
    expect(error.message).toContain("TRANSPORT_ERROR"); expect(error.message).not.toContain("private-key");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not send a cancelled request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController(); abort.abort();
    await expect(client().synthesize(request, abort.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
