import { ProviderError } from "./provider-error.js";

/** Tencent TokenHub custom voice tasks. IDs are strings (larger than JS safe integers). */
export interface KlingVoiceTask {
  taskId: string;
  status: "submitted" | "processing" | "succeed" | "failed";
  voiceId?: string;
  error?: string;
}
export interface KlingVoiceProvider {
  create(input: { voiceName: string; voiceUrl: string; externalTaskId: string }, signal?: AbortSignal): Promise<KlingVoiceTask>;
  poll(taskId: string, signal?: AbortSignal): Promise<KlingVoiceTask>;
}

export interface KlingVoiceScope {
  userId: string;
  taskId: string;
  slot: number;
  /** Hash of gateway, user credential and source; never contains the credential. */
  fingerprint: string;
}
export interface KlingVoiceCheckpoint {
  externalTaskId: string;
  vendorTaskId?: string;
  voiceId?: string;
}
/** Durable claim must precede the remote write, including before its task ID is known. */
export interface KlingVoiceStore {
  /** Read without creating intent; reject an existing row with a different scope. */
  get(scope: KlingVoiceScope): Promise<KlingVoiceCheckpoint | null>;
  claim(scope: KlingVoiceScope, externalTaskId: string): Promise<{ created: boolean; checkpoint: KlingVoiceCheckpoint }>;
  save(scope: KlingVoiceScope, result: { vendorTaskId: string; voiceId?: string }): Promise<void>;
}

export class HttpKlingVoiceProvider implements KlingVoiceProvider {
  constructor(private readonly options: { baseUrl: string; apiKey: string; timeoutMs?: number }) {}

  private async request(path: string, method: "POST" | "GET", body: unknown, signal?: AbortSignal): Promise<KlingVoiceTask> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    // No POST retries or redirects: the remote write may have succeeded, and a
    // redirect must not receive the user's bearer credential.
    const phase = method === "POST" ? "create" : "poll";
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/wand/kling/custom-voices${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    }).catch(() => { throw new ProviderError("kling-voice", phase, "TRANSPORT_ERROR"); });
    // Only bounded, validated identifiers survive. Vendor text is untrusted.
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !json || json.code !== 0 || !json.data) {
      throw new ProviderError("kling-voice", phase, response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR", { httpStatus: response.status, requestId: json?.request_id, privateValues: [this.options.apiKey] });
    }
    const data = json.data as Record<string, unknown>;
    if (typeof data.task_id !== "string" || !data.task_id || (typeof data.task_status !== "string" || !["submitted", "processing", "succeed", "failed"].includes(data.task_status))) {
      throw new Error("Kling 音色接口返回无效任务，请查询原任务后重试。");
    }
    const voices = (data.task_result as { voices?: Array<{ voice_id?: unknown; status?: string }> } | undefined)?.voices;
    const validVoices = Array.isArray(voices) ? voices.filter((voice) => voice && voice.status === "succeed" && typeof voice.voice_id === "string" && voice.voice_id.trim()) : [];
    if (data.task_status === "succeed" && validVoices.length !== 1) throw new Error("Kling 音色任务未返回唯一可用音色，请使用单人声音样例。");
    return { taskId: data.task_id, status: data.task_status as KlingVoiceTask["status"], ...(data.task_status === "failed" ? { error: new ProviderError("kling-voice", phase, "TASK_FAILED", { httpStatus: response.status }).message } : {}), voiceId: data.task_status === "succeed" ? validVoices[0]?.voice_id as string : undefined };
  }

  create(input: { voiceName: string; voiceUrl: string; externalTaskId: string }, signal?: AbortSignal) {
    return this.request("", "POST", { voice_name: input.voiceName, voice_url: input.voiceUrl, external_task_id: input.externalTaskId }, signal);
  }
  poll(taskId: string, signal?: AbortSignal) {
    return this.request(`/${encodeURIComponent(taskId)}`, "GET", undefined, signal);
  }
}
