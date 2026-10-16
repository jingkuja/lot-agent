import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpVideoGenerationProvider, OpenaiVideoAdapter } from "./video-generation.js";
import { HttpKlingVoiceProvider } from "./kling-voices.js";
import { ProviderError } from "./provider-error.js";

const sentinel = "private-prompt-SENTINEL";
const body = `${sentinel} https://private.example/a?material_token=TOKEN-SENTINEL Bearer KEY-SENTINEL ${"x".repeat(10_000)}`;
const provider = () => new HttpVideoGenerationProvider({ baseUrl: "https://vendor.example", apiKey: "KEY-SENTINEL", adapter: new OpenaiVideoAdapter(), model: "fixture" });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("untrusted diagnostics", () => {
  it.each(["create", "poll", "resume"])("keeps %s errors and logs safe without knowing the prompt", async phase => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi.fn(async () => Response.json({ status: "failed", message: body, error: body, code: body, request_id: body }, { status: phase === "create" ? 422 : 200 }));
    vi.stubGlobal("fetch", fetcher);
    const client = provider();
    const result = phase === "create" ? await client.create({ prompt: sentinel }).catch(error => error)
      : await client.poll("original-id");
    const diagnostic = result instanceof Error ? result.message + JSON.stringify(result) : JSON.stringify(result);
    expect(diagnostic).toContain(phase === "create" ? "HTTP_ERROR" : "TASK_FAILED");
    expect(diagnostic + JSON.stringify(log.mock.calls)).not.toMatch(/SENTINEL|private\.example|material_token|Bearer|xxxxxxxx/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["text", "network", "invalid-json"])("bounds poll %s errors", async kind => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (kind === "network") throw new Error(body);
      return new Response(body, { status: kind === "text" ? 503 : 200 });
    }));
    const error = await provider().poll("original-id").catch(error => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.message + JSON.stringify(error)).not.toMatch(/SENTINEL|private\.example|xxxxxxxx/);
  });
  it("omits malformed IDs and credential-shaped IDs, but preserves validated request IDs", () => {
    for (const requestId of [body, "req-abcdef123456", "req-invalid", "\nsecret"]) {
      const error = new ProviderError("generation", "create", "HTTP_ERROR", { requestId, privateValues: ["req-abcdef123456"] });
      expect(error.requestId).toBeUndefined(); expect(error.retryable).toBe(false);
    }
    expect(new ProviderError("generation", "poll", "HTTP_ERROR", { requestId: "req-abcdef123456" }).requestId).toBe("req-abcdef123456");
  });
  it.each(["create", "poll"])("also protects voice %s diagnostics", async phase => {
    const fetcher = vi.fn(async () => Response.json({ code: 0, data: { task_id: "known", task_status: "failed", task_status_msg: body } }));
    vi.stubGlobal("fetch", fetcher);
    const voice = new HttpKlingVoiceProvider({ baseUrl: "https://vendor.example", apiKey: "KEY-SENTINEL" });
    const result = phase === "create" ? await voice.create({ voiceName: "sample", voiceUrl: "https://media.example/a.wav", externalTaskId: "intent" }) : await voice.poll("known");
    expect(result.error).toContain("TASK_FAILED"); expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
