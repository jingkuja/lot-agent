import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSummary, type ModelStepReceipt } from "@lot-agent/core/marketing-analysis";
import { ASR_MODEL, extractAnalysisAudio, transcribeAnalysisAudio } from "./speech.js";
import { analysisUserAccess } from "./runtime.js";

const reply = { id: "receipt-1", choices: [{ message: { content: "测试录音设备，进入网站。" }, finish_reason: "stop" }], usage: { prompt_tokens: 173, completion_tokens: 7 } };
function setup(fetchImpl = vi.fn(async () => Response.json(reply))) {
  let saved: ModelStepReceipt | undefined;
  const finish = vi.fn(async (_id: string, receipt: ModelStepReceipt) => { saved = receipt; });
  const input = { audioUrl: "https://public.test/2.wav", baseUrl: "https://gateway.test/v1", apiKey: "owner-key", fetchImpl,
    ledger: { begin: vi.fn(async () => saved ?? null), finish } };
  return { input, fetchImpl, finish };
}
it("uses the Qwen input/parameters envelope, current user's key and actual receipt; reuses completed ASR", async () => {
  const f = setup();
  expect(await transcribeAnalysisAudio(f.input)).toEqual({ status: "completed", id: "a0001", text: reply.choices[0].message.content, model: ASR_MODEL });
  await transcribeAnalysisAudio(f.input);
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  const [url, options] = (f.fetchImpl.mock.calls as unknown as [string, RequestInit][])[0];
  expect(url).toBe("https://gateway.test/v1/chat/completions");
  expect(options.headers).toMatchObject({ Authorization: "Bearer owner-key" });
  expect(JSON.parse(options.body as string)).toEqual({ model: ASR_MODEL,
    input: { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: f.input.audioUrl } }] }] },
    parameters: { format: "wav", sample_rate: "16000" } });
  expect(f.finish).toHaveBeenCalledWith("asr:source", { text: reply.choices[0].message.content, responseId: "receipt-1", outcome: "completed", usage: { promptTokens: 173, completionTokens: 7 } });
});
it.each([404, 403])("skips an explicitly unavailable model (%s) without using a substitute", async status => {
  const f = setup(vi.fn(async () => Response.json({ error: { code: "model_not_found" } }, { status })));
  expect(await transcribeAnalysisAudio(f.input)).toEqual({ status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" });
  await transcribeAnalysisAudio(f.input); expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it.each(["network", "usage", "truncated"])("blocks replay of %s results and never fabricates token usage", async kind => {
  const f = setup(vi.fn(async () => {
    if (kind === "network") throw new Error("connection lost with secret details");
    return Response.json(kind === "usage" ? { ...reply, usage: undefined } : { ...reply, choices: [{ ...reply.choices[0], finish_reason: "length" }] });
  }));
  const error = kind === "network" ? "REQUEST_UNKNOWN" : kind === "usage" ? "MODEL_USAGE_UNKNOWN" : "MODEL_STEP_FAILED";
  await expect(transcribeAnalysisAudio(f.input)).rejects.toThrow(error);
  await expect(transcribeAnalysisAudio(f.input)).rejects.toThrow(error);
  expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("keeps quota rejection actionable instead of treating it as a missing model", async () => {
  const f = setup(vi.fn(async () => Response.json({ error: { code: "insufficient_user_quota" } }, { status: 403 })));
  await expect(transcribeAnalysisAudio(f.input)).rejects.toThrow("MODEL_QUOTA");
});
it("cancels before intent creation and passes cancellation to in-flight fetch", async () => {
  const controller = new AbortController(); controller.abort(); const f = setup();
  await expect(transcribeAnalysisAudio({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(f.input.ledger.begin).not.toHaveBeenCalled();
  const inFlight = new AbortController();
  const fetchImpl = vi.fn(async (_url, options) => {
    inFlight.abort(); options.signal.throwIfAborted(); return Response.json(reply);
  }) as unknown as typeof fetch;
  await expect(transcribeAnalysisAudio({ ...f.input, signal: inFlight.signal, fetchImpl })).rejects.toThrow("REQUEST_UNKNOWN");
});
it("requires only the visual models, treats ASR as optional, and isolates catalog/key lookup by owner", async () => {
  const db = { getUserApiKey: vi.fn(async (owner: string) => `${owner}-key`) };
  const hub = { listModels: vi.fn(async () => ({ llm: ["kimi-k3", "deepseek-v4.1-flash"], image: [], video: [] })) };
  expect(await analysisUserAccess(db, hub, "alice")).toEqual({ key: "alice-key", asrAvailable: false });
  hub.listModels.mockResolvedValue({ llm: ["kimi-k3", "deepseek-v4.1-flash", ASR_MODEL], image: [], video: [] });
  expect(await analysisUserAccess(db, hub, "bob")).toEqual({ key: "bob-key", asrAvailable: true });
  expect(hub.listModels).toHaveBeenLastCalledWith("bob-key", expect.any(AbortSignal));
});
it("extracts bounded mono 16k WAV with the sandbox and skips absent audio tracks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lot-asr-"));
  const source = { platform: "bilibili" as const, canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD", mediaKey: "source.mp4" };
  await writeFile(join(directory, "source.mp4"), Buffer.from("0000ftypfixture"));
  const run = vi.fn(async (command: string) => {
    if (command === "ffprobe") return { stdout: '{"streams":[{"codec_type":"audio"}]}', stderr: "" };
    await writeFile(join(directory, "speech.wav"), Buffer.from("RIFF0000WAVEfixture"));
    return { stdout: "", stderr: "" };
  });
  try {
    expect(await extractAnalysisAudio({ directory, source, runner: { run } })).toEqual(Buffer.from("RIFF0000WAVEfixture"));
    expect(run).toHaveBeenLastCalledWith("ffmpeg", expect.arrayContaining(["-ac", "1", "-ar", "16000", "-protocol_whitelist", "file", "-t", "180"]), undefined);
    run.mockResolvedValue({ stdout: '{"streams":[]}', stderr: "" });
    expect(await extractAnalysisAudio({ directory, source, runner: { run } })).toBeNull();
  } finally { await rm(directory, { force: true, recursive: true }); }
});
it("permits transcript evidence only when supplied and never invents word timestamps", () => {
  const speech = { status: "completed" as const, id: "a0001" as const, text: "欢迎光临", model: ASR_MODEL };
  const fact = { statement: "欢迎光临", evidenceIds: ["a0001"], inference: false };
  const summary = { summary: [fact], timeline: [], marketingPoints: [], limitations: [] };
  expect(validateSummary(summary, [], [], 1000, speech)).toEqual(summary);
  expect(() => validateSummary(summary, [], [], 1000)).toThrow("INVALID_EVIDENCE_REFERENCE");
  expect(() => validateSummary({ ...summary, timeline: [{ ...fact, startMs: 0, endMs: 1000 }] }, [], [], 1000, speech)).toThrow("INVALID_TIMELINE_RANGE");
});
it("reuses the same audio receipt when a temporary URL rotates", async () => {
  const f = setup();
  await transcribeAnalysisAudio({ ...f.input, audioHash: "a".repeat(64) });
  await transcribeAnalysisAudio({ ...f.input, audioHash: "a".repeat(64), audioUrl: "https://public.test/new-token" });
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  expect(f.input.ledger.begin.mock.calls[0]).toEqual(f.input.ledger.begin.mock.calls[1]);
});
