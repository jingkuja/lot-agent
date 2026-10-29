import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDeadline, gatewayRequestId, withAbort } from "@lot-agent/core";
import { ANALYSIS_LIMITS, type AnalysisCallLedger, type AnalysisSource, type AnalysisSpeech, type ModelStepReceipt } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import { readAnalysisFile } from "./private-files.js";
import type { MediaRunner } from "./sandbox.js";
import { gatewayModelHeaders } from "../tokenhub/model-access.js";

export const ASR_MODEL = "qwen-audio-3.1-asr-flash";
const maxAudioBytes = 180 * 16000 * 2 + 4096;

/** Decode only a private, signature-checked container in the existing networkless sandbox. */
export async function extractAnalysisAudio(input: { directory: string; source: AnalysisSource; runner: MediaRunner; signal?: AbortSignal }): Promise<Buffer | null> {
  input.signal?.throwIfAborted();
  const key = input.source.mediaKey;
  if (!key || !/^source\.(mp4|webm|mkv)$/.test(key)) throw new AnalysisError("INVALID_PRIVATE_FILE");
  const handle = await open(join(input.directory, key), constants.O_RDONLY | constants.O_NOFOLLOW);
  let format: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > ANALYSIS_LIMITS.downloadBytes) throw new AnalysisError("INVALID_PRIVATE_FILE");
    const head = Buffer.alloc(32); await handle.read(head);
    format = head.toString("ascii", 4, 8) === "ftyp" ? "mov" : head.readUInt32BE(0) === 0x1a45dfa3 ? "matroska" : "";
    if (!format) throw new AnalysisError("UNSUPPORTED_SOURCE");
  } finally { await handle.close(); }
  const local = `/work/${key}`;
  const probe = JSON.parse((await input.runner.run("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-f", format, "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "json", local], input.signal)).stdout);
  if (!Array.isArray(probe.streams)) throw new AnalysisError("UNSUPPORTED_SOURCE");
  if (!probe.streams.length) return null;
  try {
    await input.runner.run("ffmpeg", ["-nostdin", "-hide_banner", "-y", "-v", "error", "-threads", "2", "-protocol_whitelist", "file", "-f", format, "-i", local,
      "-map", "0:a:0", "-vn", "-t", "180", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "/work/speech.wav"], input.signal);
    const audio = await readAnalysisFile(input.directory, "speech.wav", maxAudioBytes);
    if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") throw new AnalysisError("INVALID_PRIVATE_FILE");
    return audio;
  } finally { await rm(join(input.directory, "speech.wav"), { force: true }); }
}

async function boundedJson(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new AnalysisError("MODEL_INVALID_RESPONSE");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await withAbort(reader.read(), signal); if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw new AnalysisError("MODEL_OUTPUT_LIMIT");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    // A stalled transport's cancel promise must not hold the worker lease.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The Qwen gateway has its own input/parameters envelope, not the LLM messages envelope.
 * Audio is fetched through a short-lived URL rooted at PUBLIC_BASE_URL. */
export async function transcribeAnalysisAudio(input: {
  audioUrl: string; audioHash?: string; baseUrl: string; apiKey: string; ledger: AnalysisCallLedger; signal?: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<AnalysisSpeech> {
  input.signal?.throwIfAborted();
  if (!input.apiKey) throw new AnalysisError("MODEL_AUTH_REQUIRED", 503);
  if (!/^https?:\/\//.test(input.audioUrl)) throw new AnalysisError("ASR_PUBLIC_URL_REQUIRED", 503);
  const payload = JSON.stringify({ model: ASR_MODEL, input: { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: input.audioUrl } }] }] }, parameters: { format: "wav", sample_rate: "16000" } });
  const step = "asr:source";
  let receipt = await input.ledger.begin(step, createHash("sha256").update(input.audioHash ? JSON.stringify({ model: ASR_MODEL, audioHash: input.audioHash, format: "wav", sample_rate: "16000" }) : payload).digest("hex"), ASR_MODEL, 0);
  if (!receipt) {
    receipt = { text: "", outcome: "request_unknown" };
    const deadline = createDeadline(180000, input.signal);
    let responded = false;
    try {
      deadline.signal.throwIfAborted();
      const response = await withAbort((input.fetchImpl ?? fetch)(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", redirect: "error",
        headers: { ...gatewayModelHeaders(), Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" }, body: payload,
        signal: deadline.signal,
      }), deadline.signal);
      const requestId = gatewayRequestId(response.headers);
      if (requestId) receipt.gatewayRequestId = requestId;
      if (!response.ok) {
        const error = await boundedJson(response, deadline.signal).catch(() => null);
        const code = error?.error?.code;
        const missing = response.status === 404 || ([400, 403].includes(response.status) && ["model_not_found", "model_not_available", "model_not_allowed"].includes(code));
        if (missing || [401, 402, 403, 429].includes(response.status)) {
          receipt.outcome = "rejected";
          receipt.errorCode = missing ? "ASR_MODEL_UNAVAILABLE" : response.status === 402 || ["insufficient_quota", "insufficient_user_quota", "insufficient_balance"].includes(code) ? "MODEL_QUOTA" : response.status === 429 ? "MODEL_RATE_LIMIT" : "MODEL_AUTH_REQUIRED";
        } else { receipt.outcome = "cancelled"; receipt.errorCode = "MODEL_NO_RESPONSE"; }
      } else {
        responded = true;
        const result = await boundedJson(response, deadline.signal);
        if (typeof result.id === "string" && result.id.length <= 500) receipt.responseId = result.id;
        const usage = result.usage;
        if (usage && [usage.prompt_tokens, usage.completion_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) receipt.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
        const choice = result.choices?.[0];
        if (typeof choice?.message?.content === "string" && choice.message.content.length <= 30000) {
          receipt.text = choice.message.content;
          receipt.outcome = choice.finish_reason === "stop" ? "completed" : "failed";
        } else if (receipt.usage) receipt.outcome = "failed";
      }
    } catch {
      // No response at all (timeout, lost connection) is not charged and may be resumed. A response
      // that broke off while reading stays unknown: an ambiguous paid request is never retried automatically.
      if (!responded && receipt.outcome === "request_unknown") { receipt.outcome = "cancelled"; receipt.errorCode = "MODEL_NO_RESPONSE"; }
    }
    finally { deadline.dispose(); }
    await input.ledger.finish(step, receipt);
  }
  return speechFromReceipt(receipt);
}

/** A completed ledger entry is sufficient even after the private source expires. */
export function speechFromReceipt(receipt: ModelStepReceipt): AnalysisSpeech {
  if (receipt.errorCode === "ASR_MODEL_UNAVAILABLE" && receipt.outcome === "rejected") return { status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" };
  if (receipt.outcome === "rejected") throw new AnalysisError(receipt.errorCode ?? "MODEL_AUTH_REQUIRED", 409);
  if (receipt.outcome === "request_unknown") throw new AnalysisError("REQUEST_UNKNOWN", 409);
  if (receipt.outcome === "cancelled") throw new AnalysisError(receipt.errorCode ?? "MODEL_NO_RESPONSE", 409);
  if (!receipt.usage || ![receipt.usage.promptTokens, receipt.usage.completionTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new AnalysisError("MODEL_USAGE_UNKNOWN", 409);
  if (receipt.outcome !== "completed") throw new AnalysisError("MODEL_STEP_FAILED", 409);
  if (typeof receipt.text !== "string" || receipt.text.length > 30000) throw new AnalysisError("MODEL_INVALID_RESPONSE");
  return { status: "completed", id: "a0001", text: receipt.text, model: ASR_MODEL };
}
