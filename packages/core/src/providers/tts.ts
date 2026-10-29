import { ProviderError } from "./provider-error.js";
import { gatewayRequestId } from "../llm/gateway-request-id.js";

export interface TTSRequest { text: string; voice?: string; }
export interface TTSResult { audioUrl: string; characters: number; raw?: unknown; }
export interface TTSProvider { synthesize(req: TTSRequest): Promise<TTSResult>; }

export class StubTTSProvider implements TTSProvider {
  async synthesize(req: TTSRequest): Promise<TTSResult> {
    return { audioUrl: `stub://tts?text=${encodeURIComponent(req.text)}`, characters: req.text.length };
  }
}

export type SpeechFormat = "mp3" | "wav" | "pcm" | "opus";
export interface SpeechRequest {
  model: string;
  text: string;
  /** Vendor voice ID bound to `model`; no OpenAI voice-name mapping. */
  voice: string;
  format?: SpeechFormat;
  /** 0.5–2.0 */
  speed?: number;
  instructions?: string;
}
export interface SpeechResult {
  audio: Uint8Array; mime: string;
  /** The gateway's log ID (`x-oneapi-request-id`), to match a charge or a slow request in its logs. */
  gatewayRequestId?: string;
}
export interface SpeechProvider { synthesize(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult> }

const SPEECH_MIME: Record<SpeechFormat, string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"], wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  pcm: ["application/octet-stream", "audio/pcm"], opus: ["audio/ogg", "audio/opus"],
};

/** OpenAI-compatible `POST {baseUrl}/audio/speech`, e.g. New API in front of Qwen Audio TTS. */
export class OpenAISpeechProvider implements SpeechProvider {
  constructor(private readonly options: {
    baseUrl: string; apiKey: string; timeoutMs?: number; maxBytes?: number; headers?: Record<string, string>;
  }) {}

  async synthesize(req: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult> {
    signal?.throwIfAborted();
    const format = req.format ?? "mp3";
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 120_000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let requestId: string | undefined;
    const fail = (code: "TRANSPORT_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE", status?: number) =>
      new ProviderError("speech", "create", code, { httpStatus: status, gatewayRequestId: requestId, privateValues: [this.options.apiKey] });
    // Synthesis is billed per request. Never retry, even when no response arrived.
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/audio/speech`, {
        method: "POST", redirect: "error", signal: combined,
        headers: { ...this.options.headers, Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: req.model, input: req.text, voice: req.voice, response_format: format, speed: req.speed, instructions: req.instructions || undefined }),
      });
    } catch { signal?.throwIfAborted(); throw fail("TRANSPORT_ERROR"); }
    requestId = gatewayRequestId(response.headers);
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail("HTTP_ERROR", response.status); }
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!SPEECH_MIME[format].includes(mime)) { await response.body?.cancel().catch(() => {}); throw fail("INVALID_RESPONSE", response.status); }
    const maxBytes = this.options.maxBytes ?? 20 * 1024 * 1024;
    const parts: Uint8Array[] = []; let size = 0;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw fail("INVALID_RESPONSE");
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw fail("INVALID_RESPONSE"); }
        parts.push(value);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      signal?.throwIfAborted(); throw fail("TRANSPORT_ERROR");
    }
    if (!size) throw fail("INVALID_RESPONSE");
    const audio = new Uint8Array(size); let offset = 0;
    for (const part of parts) { audio.set(part, offset); offset += part.byteLength; }
    return { audio, mime: SPEECH_MIME[format][0], ...(requestId ? { gatewayRequestId: requestId } : {}) };
  }
}
