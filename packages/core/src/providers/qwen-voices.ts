import { z } from "zod";
import { ProviderError } from "./provider-error.js";

export type QwenVoiceStatus = "DEPLOYING" | "OK" | "UNDEPLOYED";
export interface QwenVoice { voiceId: string; status: QwenVoiceStatus }
export interface TwinVoiceScope { ownerId: string; itemId: string; revisionId: string }
export interface TwinVoiceRecord {
  targetModel: string;
  credentialScope: string;
  prefix: string;
  voiceId: string | null;
  status: QwenVoiceStatus | "unknown";
}
export interface TwinVoiceStore {
  get(scope: TwinVoiceScope): Promise<TwinVoiceRecord | null>;
  claim(scope: TwinVoiceScope, record: TwinVoiceRecord): Promise<{ created: boolean; record: TwinVoiceRecord }>;
  save(scope: TwinVoiceScope, record: TwinVoiceRecord): Promise<void>;
  /** Drops an unresolved claim (same prefix, no voice ID) so enrollment can start over. */
  release(scope: TwinVoiceScope, record: TwinVoiceRecord): Promise<void>;
}
/** Dubbing preview with a cloned voice. Model and voice ID come only from the stored record. */
export const TwinSpeechInputSchema = z.object({
  text: z.string().trim().min(1).max(500),
  speed: z.number().min(0.5).max(2).optional(),
  instructions: z.string().trim().max(200).optional(),
}).strict();
export type TwinSpeechInput = z.infer<typeof TwinSpeechInputSchema>;

/** These IDs belong to targetModel and must never be passed to Kling. */
export interface QwenVoiceProvider {
  create(input: { url: string; prefix: string }, signal?: AbortSignal): Promise<string>;
  query(voiceId: string, signal?: AbortSignal): Promise<QwenVoice>;
  find(prefix: string, signal?: AbortSignal): Promise<QwenVoice | null>;
}

/** True only when Qwen answered and refused create_voice, so no voice can exist for that prefix.
 * Transport errors, 408 / 5xx and malformed success bodies remain uncertain. */
export function isQwenCreateRejected(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.provider !== "qwen-voice" || error.phase !== "create") return false;
  const status = error.httpStatus ?? 0;
  return error.code === "TASK_FAILED" || (error.code === "HTTP_ERROR" && status >= 400 && status < 500 && status !== 408);
}

const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_.-]{1,256}$/.test(id);
const validStatus = (status: unknown): status is QwenVoiceStatus => ["DEPLOYING", "OK", "UNDEPLOYED"].includes(status as string);

export class HttpQwenVoiceProvider implements QwenVoiceProvider {
  constructor(private readonly options: { baseUrl: string; apiKey: string; targetModel: string; timeoutMs?: number }) {}

  private async request(input: object, phase: "create" | "poll", signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const fail = (code: "TRANSPORT_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE" | "TASK_FAILED", status?: number, requestId?: unknown) =>
      new ProviderError("qwen-voice", phase, code, { httpStatus: status, requestId, privateValues: [this.options.apiKey] });
    // All operations use POST, but only create_voice writes. Never retry it.
    let response: Response; let json: Record<string, unknown> | null;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/services/audio/tts/customization`, {
        method: "POST", redirect: "error", signal: combined,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "voice-enrollment", input }),
      });
      json = await response.json().catch(() => null) as Record<string, unknown> | null;
    } catch { throw fail("TRANSPORT_ERROR"); }
    if (!response.ok || !json || json.code || !json.output || typeof json.output !== "object" || Array.isArray(json.output)) {
      // A 2xx carrying a vendor error code is a refusal; other malformed 2xx bodies stay uncertain.
      throw fail(!response.ok ? "HTTP_ERROR" : typeof json?.code === "string" && json.code ? "TASK_FAILED" : "INVALID_RESPONSE", response.status, json?.request_id);
    }
    return json.output as Record<string, unknown>;
  }

  async create(input: { url: string; prefix: string }, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9]{1,10}$/.test(input.prefix)) throw new Error("音色前缀无效");
    const result = await this.request({ action: "create_voice", target_model: this.options.targetModel, url: input.url, prefix: input.prefix }, "create", signal);
    if (!validId(result.voice_id) || !result.voice_id.startsWith(`${this.options.targetModel}-${input.prefix}-`)) throw new ProviderError("qwen-voice", "create", "INVALID_RESPONSE");
    return result.voice_id;
  }

  async query(voiceId: string, signal?: AbortSignal): Promise<QwenVoice> {
    if (!validId(voiceId)) throw new Error("音色标识无效");
    const result = await this.request({ action: "query_voice", voice_id: voiceId }, "poll", signal);
    if (!validStatus(result.status) || result.target_model !== this.options.targetModel) throw new ProviderError("qwen-voice", "poll", "INVALID_RESPONSE");
    return { voiceId, status: result.status };
  }

  async find(prefix: string, signal?: AbortSignal): Promise<QwenVoice | null> {
    if (!/^[A-Za-z0-9]{1,10}$/.test(prefix)) throw new Error("音色前缀无效");
    const result = await this.request({ action: "list_voice", prefix, page_index: 0, page_size: 100 }, "poll", signal);
    if (!Array.isArray(result.voice_list)) throw new ProviderError("qwen-voice", "poll", "INVALID_RESPONSE");
    // Exact model/prefix match prevents a partial vendor filter from adopting
    // someone else's voice. Ambiguous results require manual reconciliation.
    const matches = result.voice_list.filter((v): v is { voice_id: string; status: QwenVoiceStatus } =>
      !!v && validId(v.voice_id) && v.voice_id.startsWith(`${this.options.targetModel}-${prefix}-`) && validStatus(v.status));
    if (matches.length > 1 || result.voice_list.length >= 100) throw new ProviderError("qwen-voice", "poll", "INVALID_RESPONSE");
    return matches[0] ? { voiceId: matches[0].voice_id, status: matches[0].status } : null;
  }
}
