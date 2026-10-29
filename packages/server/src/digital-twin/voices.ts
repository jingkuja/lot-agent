import { createHash, randomBytes } from "node:crypto";
import { assertPublicUrl, HttpQwenVoiceProvider, isQwenCreateRejected, OpenAISpeechProvider, type QwenVoiceProvider, type SpeechFormat, type SpeechProvider, type SpeechResult, type TwinSpeechInput, type TwinVoiceRecord, type TwinVoiceScope, type TwinVoiceStore } from "@lot-agent/core";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import type { LocalKnowledgeStorage } from "../knowledge/private-storage.js";
import { KnowledgeError } from "../knowledge/errors.js";
import { inspectMedia } from "../marketing-video/media.js";
import { gatewayModelHeaders } from "../tokenhub/model-access.js";

export function loadTwinVoiceConfig() {
  return {
    baseUrl: process.env.QWEN_VOICE_BASE_URL?.trim() || "https://maas.qianwenaiapi.com/api/v1",
    apiKey: process.env.QWEN_VOICE_API_KEY?.trim() || "",
    targetModel: process.env.QWEN_VOICE_TARGET_MODEL?.trim() || "qwen-audio-3.0-tts-plus",
  };
}
/** Age after which an unconfirmed create that the vendor never listed may be enrolled again. */
export const UNCONFIRMED_CREATE_RELEASE_MS = 2 * 60_000;
export type TwinVoiceView =Pick<TwinVoiceRecord, "targetModel" | "voiceId" | "status">;
export type ReadyTwinVoice = { targetModel: string; voiceId: string };
const view = ({ targetModel, voiceId, status }: TwinVoiceRecord): TwinVoiceView => ({ targetModel, voiceId, status });

/** Speech goes through the user's own New API key so the gateway bills that user. */
export interface TwinSpeechDeps {
  apiKey(ownerId: string): Promise<string | null>;
  baseUrl(): string;
  provider?: (options: { baseUrl: string; apiKey: string; headers?: Record<string, string> }) => SpeechProvider;
}

export class TwinVoices {
  constructor(private readonly deps: {
    repository: Pick<KnowledgeRepository, "getItem" | "getFile" | "createPreviewTicket">;
    storage: Pick<LocalKnowledgeStorage, "localPath">;
    store: TwinVoiceStore;
    config?: () => ReturnType<typeof loadTwinVoiceConfig>;
    provider?: (config: ReturnType<typeof loadTwinVoiceConfig>) => QwenVoiceProvider;
    inspect?: typeof inspectMedia;
    validateUrl?: (url: string) => Promise<void>;
    publicBaseUrl?: () => string;
    speech?: TwinSpeechDeps;
  }) {}

  private async owned(ownerId: string, itemId: string): Promise<TwinVoiceScope> {
    const item = await this.deps.repository.getItem(ownerId, itemId);
    if (item.sourceType !== "audio" || !item.tags.includes("digital-twin:voice")) throw new KnowledgeError("NOT_FOUND", 404, "声音样例不存在");
    return { ownerId, itemId, revisionId: item.revisionId };
  }
  async get(ownerId: string, itemId: string): Promise<TwinVoiceView | null> {
    const record = await this.deps.store.get(await this.owned(ownerId, itemId));
    return record ? view(record) : null;
  }

  /** Repeated calls reconcile the same enrollment; only the atomic winner creates. */
  async enroll(ownerId: string, itemId: string, sessionToken: string, signal?: AbortSignal): Promise<TwinVoiceView> {
    const scope = await this.owned(ownerId, itemId);
    const config = (this.deps.config ?? loadTwinVoiceConfig)();
    if (!config.apiKey) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "声音复刻服务尚未配置，请联系管理员");
    const credentialScope = createHash("sha256").update(JSON.stringify([config.baseUrl.replace(/\/+$/, ""), config.apiKey])).digest("hex");
    const provider = this.deps.provider?.(config) ?? new HttpQwenVoiceProvider(config);
    let record = await this.deps.store.get(scope);
    let url: string | undefined;
    if (!record) {
      const file = await this.deps.repository.getFile(ownerId, itemId, scope.revisionId);
      if (!["audio/mpeg", "audio/wav"].includes(file.mime) || file.size > 15 * 1024 * 1024) throw new KnowledgeError("UNSUPPORTED_MEDIA", 415, "声音样例仅支持 15 MB 以内的 MP3、WAV");
      const info = await (this.deps.inspect ?? inspectMedia)(this.deps.storage.localPath(file.key), signal);
      if (!info.audio || info.duration < 2 || info.duration > 15) throw new KnowledgeError("INVALID_REQUEST", 400, "声音样例时长需为 2–15 秒");
      const base = this.deps.publicBaseUrl?.() ?? process.env.PUBLIC_BASE_URL ?? "";
      let parsed: URL;
      try { parsed = new URL(base); } catch { throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "声音样例公网访问尚未配置，请联系管理员"); }
      if (parsed.username || parsed.password || parsed.search || parsed.hash || !["https:", "http:"].includes(parsed.protocol)) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "声音复刻公网地址配置无效");
      await (this.deps.validateUrl ?? assertPublicUrl)(parsed.href);
      // Reuse session-bound, five-minute knowledge preview capabilities. No
      // private blob is published or copied into static storage.
      const ticket = await this.deps.repository.createPreviewTicket(ownerId, sessionToken, itemId, scope.revisionId);
      url = `${base.replace(/\/+$/, "")}/api/rag/preview/${ticket.token}`;
    }
    signal?.throwIfAborted();
    const claim = record ? { created: false, record } : await this.deps.store.claim(scope, {
      targetModel: config.targetModel, credentialScope, prefix: randomBytes(5).toString("hex"), voiceId: null, status: "unknown",
    });
    record = claim.record;
    if (record.credentialScope !== credentialScope || record.targetModel !== config.targetModel) throw new KnowledgeError("CONFLICT", 409, "音色服务配置已变化，请联系管理员核实原音色");
    if (record.status === "OK" || record.status === "UNDEPLOYED") return view(record);
    // Store intent before network I/O. No create retry, even when no response
    // arrived; the unique persisted prefix allows read-only recovery.
    if (claim.created) {
      let voiceId: string;
      try { voiceId = await provider.create({ url: url!, prefix: record.prefix }, signal); }
      catch (error) {
        // An explicit refusal created nothing; release the claim so the user can enroll again.
        if (isQwenCreateRejected(error)) await this.deps.store.release(scope, record);
        throw error;
      }
      record = { ...record, voiceId, status: "DEPLOYING" };
    } else {
      const remote = record.voiceId ? await provider.query(record.voiceId, signal) : await provider.find(record.prefix, signal);
      if (!remote) {
        // create_voice answers within its 30 s deadline. A claim still missing from the
        // vendor's list well after that produced no voice; free it instead of pending forever.
        if (!record.voiceId && await this.deps.store.release(scope, record, { olderThanMs: UNCONFIRMED_CREATE_RELEASE_MS })) {
          throw new KnowledgeError("CONFLICT", 409, "千问未生成该音色，请重新复刻声音");
        }
        return view(record);
      }
      record = { ...record, ...remote };
    }
    await this.deps.store.save(scope, record);
    // Return persisted state so a slower status read cannot regress a terminal result.
    return view((await this.deps.store.get(scope))!);
  }

  /** The owner's cloned voice of a twin voice item, only once it can synthesize. */
  async ready(ownerId: string, itemId: string): Promise<ReadyTwinVoice> {
    const record = await this.deps.store.get(await this.owned(ownerId, itemId));
    if (record?.status !== "OK" || !record.voiceId) throw new KnowledgeError("CONFLICT", 409, "音色尚未就绪，请先完成声音复刻");
    return { targetModel: record.targetModel, voiceId: record.voiceId };
  }

  /** Synthesizes with the voice's own target model. One billed request; no retry. */
  async speak(ownerId: string, itemId: string, input: TwinSpeechInput, signal?: AbortSignal): Promise<SpeechResult> {
    return this.speakAs(ownerId, await this.ready(ownerId, itemId), input, "mp3", signal);
  }

  /** Synthesizes with a voice from `ready`, so callers can key results by that exact voice. */
  async speakAs(ownerId: string, voice: ReadyTwinVoice, input: TwinSpeechInput, format: SpeechFormat, signal?: AbortSignal): Promise<SpeechResult> {
    const speech = this.deps.speech;
    if (!speech) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "语音合成服务不可用");
    const apiKey = await speech.apiKey(ownerId);
    if (!apiKey) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "模型账号不可用，请重新登录后重试");
    const options = { baseUrl: speech.baseUrl(), apiKey, headers: gatewayModelHeaders() };
    const provider = speech.provider?.(options) ?? new OpenAISpeechProvider(options);
    return provider.synthesize({ model: voice.targetModel, text: input.text, voice: voice.voiceId, format, speed: input.speed, instructions: input.instructions }, signal);
  }
}
