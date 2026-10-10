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
  claim(scope: KlingVoiceScope, externalTaskId: string): Promise<{ created: boolean; checkpoint: KlingVoiceCheckpoint }>;
  save(scope: KlingVoiceScope, result: { vendorTaskId: string; voiceId?: string }): Promise<void>;
}

/** Keep vendor diagnostics useful without echoing credentials or signed media URLs. */
function safeVoiceDiagnostic(value: unknown, apiKey: string): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let text = String(value);
  if (apiKey) text = text.split(apiKey).join("[redacted]");
  return text
    .replace(/Bearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

function voiceFailure(status: number, json: Record<string, unknown> | null, apiKey: string): string {
  const nested = json?.error && typeof json.error === "object" ? json.error as Record<string, unknown> : undefined;
  const code = safeVoiceDiagnostic(json?.code ?? nested?.code, apiKey);
  const requestId = safeVoiceDiagnostic(json?.request_id, apiKey);
  const message = safeVoiceDiagnostic(json?.message ?? nested?.message, apiKey);
  const fields = [`HTTP ${status}`, ...(code ? [`code: ${code}`] : []), ...(requestId ? [`request_id: ${requestId}`] : [])];
  return `Kling 音色接口请求失败（${fields.join("，")}）${message ? `：${message}` : ""}`;
}

export class HttpKlingVoiceProvider implements KlingVoiceProvider {
  constructor(private readonly options: { baseUrl: string; apiKey: string; timeoutMs?: number }) {}

  private async request(path: string, method: "POST" | "GET", body: unknown, signal?: AbortSignal): Promise<KlingVoiceTask> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    // No POST retries or redirects: the remote write may have succeeded, and a
    // redirect must not receive the user's bearer credential.
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/wand/kling/custom-voices${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    // Error bodies carry the actionable validation reason even on HTTP 400.
    // Only selected, redacted fields reach the message card; never dump the body.
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !json || json.code !== 0 || !json.data) {
      throw new Error(voiceFailure(response.status, json, this.options.apiKey));
    }
    const data = json.data as Record<string, unknown>;
    if (typeof data.task_id !== "string" || !data.task_id || (typeof data.task_status !== "string" || !["submitted", "processing", "succeed", "failed"].includes(data.task_status))) {
      throw new Error("Kling 音色接口返回无效任务，请查询原任务后重试。");
    }
    const voices = (data.task_result as { voices?: Array<{ voice_id?: unknown; status?: string }> } | undefined)?.voices;
    const validVoices = Array.isArray(voices) ? voices.filter((voice) => voice && voice.status === "succeed" && typeof voice.voice_id === "string" && voice.voice_id.trim()) : [];
    if (data.task_status === "succeed" && validVoices.length !== 1) throw new Error("Kling 音色任务未返回唯一可用音色，请使用单人声音样例。");
    return { taskId: data.task_id, status: data.task_status as KlingVoiceTask["status"], ...(data.task_status === "failed" ? { error: safeVoiceDiagnostic(data.task_status_msg, this.options.apiKey) } : {}), voiceId: data.task_status === "succeed" ? validVoices[0]?.voice_id as string : undefined };
  }

  create(input: { voiceName: string; voiceUrl: string; externalTaskId: string }, signal?: AbortSignal) {
    return this.request("", "POST", { voice_name: input.voiceName, voice_url: input.voiceUrl, external_task_id: input.externalTaskId }, signal);
  }
  poll(taskId: string, signal?: AbortSignal) {
    return this.request(`/${encodeURIComponent(taskId)}`, "GET", undefined, signal);
  }
}
