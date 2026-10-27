import { MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { describe, expect, it, vi } from "vitest";
import type { ChatChunk, LLMProvider, Message } from "@lot-agent/core";
import type { AnalysisSnapshot, FrameEvidence } from "@lot-agent/core/marketing-analysis";
import { AnalysisModels, userResponsesProvider, type ModelStepReceipt } from "./models.js";

const frame = (i: number): FrameEvidence => ({ id: `f${String(i + 1).padStart(4, "0")}`, ptsMs: i * 500, sourceHash: "a".repeat(64), sourcePts: String(i * 500), timeBase: "1/1000", width: 720, height: 1280, objectKey: `${i}.jpg`, reasons: [] });
function setup(reply: unknown, chunks?: ChatChunk[]) {
  const records = new Map<string, { hash: string; receipt?: ModelStepReceipt }>();
  const requests: { model: string; messages: Message[] }[] = [];
  const provider = vi.fn(async (model: string): Promise<LLMProvider> => ({ async *chat(messages) {
    requests.push({ model, messages });
    if (chunks) { yield* chunks; return; }
    yield { type: "text", content: JSON.stringify(reply) };
    yield { type: "done", finishReason: "stop", responseId: "resp1", usage: { promptTokens: 50, completionTokens: 20 } };
  } }));
  const finish = vi.fn(async (id: string, receipt: ModelStepReceipt) => { records.get(id)!.receipt = receipt; });
  const models = new AnalysisModels({ provider, readFrame: async () => Uint8Array.from([255, 216, 255, 0]), ledger: {
    begin: async (id, hash) => {
      const record = records.get(id);
      if (record && (record.hash !== hash || !record.receipt)) throw new Error("REQUEST_UNKNOWN");
      if (record) return record.receipt!;
      records.set(id, { hash }); return null;
    }, finish,
  } });
  return { models, requests, records, finish };
}

describe("analysis model calls", () => {
  it("uses DeepSeek with one image and caches completed OCR", async () => {
    const { models, requests, records } = setup({ text: "不包邮 99元" });
    expect(await models.ocr(frame(0))).toEqual({ frameId: "f0001", rawText: "不包邮 99元" });
    await models.ocr(frame(0));
    expect(requests).toHaveLength(1); expect(requests[0].model).toBe("deepseek-v4.1-flash");
    expect(requests[0].messages[1].content).toMatchObject([{ type: "text" }, { type: "image", image: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) } }]);
    expect(records.get("ocr:f0001")?.receipt?.usage?.promptTokens).toBe(50);
  });
  it("sends ordered Kimi images with interleaved time labels", async () => {
    const { models, requests } = setup({ observations: [{ description: "红盒在前，蓝盒在后", frameIds: ["f0001", "f0002"], uncertainty: "" }] });
    const result = await models.observe(0, [frame(0), frame(1)]);
    expect(result[0].frameIds).toEqual(["f0001", "f0002"]); expect(requests[0].model).toBe("kimi-k3");
    expect(requests[0].messages[1].content).toMatchObject([{ type: "text", text: "frameId=f0001; time=0ms" }, { type: "image" }, { type: "text", text: "frameId=f0002; time=500ms" }, { type: "image" }]);
    await expect(models.observe(1, [frame(1), frame(0)])).rejects.toThrow("INVALID_IMAGE_BATCH");
  });
  it("checkpoints malformed paid output and does not resample it", async () => {
    const { models, requests, records } = setup(null, [{ type: "text", content: "{incomplete" }, { type: "done", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 5 } }]);
    await expect(models.ocr(frame(0))).rejects.toThrow("MODEL_INVALID_JSON");
    await expect(models.ocr(frame(0))).rejects.toThrow("MODEL_STEP_FAILED");
    expect(requests).toHaveLength(1); expect(records.get("ocr:f0001")?.receipt?.usage).toBeDefined();
  });
  it("accepts literal line breaks inside JSON strings without changing the raw receipt or calling again", async () => {
    const source = '{"text":"It is ve\ncak\nThank you for\t99元\\nquoted \\"value\\""}';
    const { models, requests, records } = setup(null, [{ type: "text", content: source }, { type: "done", finishReason: "stop", responseId: "resp-newline", usage: { promptTokens: 713, completionTokens: 231 } }]);
    expect((await models.ocr(frame(0))).rawText).toBe('It is ve\ncak\nThank you for\t99元\nquoted "value"');
    expect(records.get("ocr:f0001")?.receipt?.text).toBe(source);
    await models.ocr(frame(0)); expect(requests).toHaveLength(1);
  });
  it("does not repair missing quotes or a truncated string", async () => {
    for (const source of ['{"text":"not finished', '{"text":"unescaped "quote" here"}', '{"text":"value\\\ncontinued"}']) {
      const { models } = setup(null, [{ type: "text", content: source }, { type: "done", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 5 } }]);
      await expect(models.ocr(frame(0))).rejects.toThrow("MODEL_INVALID_JSON");
    }
  });
  it("keeps unknown usage absent and blocks replay after interruption", async () => {
    const { models, requests, records } = setup(null, [{ type: "text", content: "partial" }]);
    await expect(models.ocr(frame(0))).rejects.toThrow("REQUEST_UNKNOWN");
    await expect(models.ocr(frame(0))).rejects.toThrow("REQUEST_UNKNOWN");
    expect(requests).toHaveLength(1); expect(records.get("ocr:f0001")?.receipt).toMatchObject({ outcome: "request_unknown" });
    expect(records.get("ocr:f0001")?.receipt).not.toHaveProperty("usage");
  });
  it.each(["length", "content_filter"])("preserves usage but rejects %s", async finishReason => {
    const { models, records } = setup(null, [{ type: "done", finishReason, usage: { promptTokens: 5, completionTokens: 2 } }]);
    await expect(models.ocr(frame(0))).rejects.toThrow("MODEL_STEP_FAILED");
    expect(records.get("ocr:f0001")?.receipt).toMatchObject({ outcome: "failed", usage: { promptTokens: 5, completionTokens: 2 } });
  });
  it("stops on missing usage without treating an unknown bill as zero", async () => {
    const { models, requests } = setup(null, [{ type: "text", content: '{"text":"99"}' }, { type: "done", finishReason: "stop" }]);
    await expect(models.ocr(frame(0))).rejects.toThrow("MODEL_USAGE_UNKNOWN");
    await expect(models.ocr(frame(0))).rejects.toThrow("MODEL_USAGE_UNKNOWN");
    expect(requests).toHaveLength(1);
  });
  it("rejects invented evidence and keeps required coverage limitations", async () => {
    const result = { summary: [{ statement: "Product", evidenceIds: ["f0001"], inference: false }], timeline: [], marketingPoints: [], limitations: [] };
    const input = { revision: 2, frames: [frame(0)], texts: [], observations: [], durationMs: 1000, limitations: ["NO_AUDIO_ANALYSIS"] };
    expect((await setup(result).models.summarize(input)).limitations).toContain("NO_AUDIO_ANALYSIS");
    await expect(setup({ ...result, summary: [{ ...result.summary[0], evidenceIds: ["f9999"] }] }).models.summarize(input)).rejects.toThrow("INVALID_EVIDENCE_REFERENCE");
  });
  it("aligns summary timing with cited observations and replays without another request", async () => {
    const result = { summary: [], timeline: [
      { startMs: 0, endMs: 100, statement: "展示产品", evidenceIds: ["f0002"], inference: false },
      { startMs: 100, endMs: 900, statement: "产品近景", evidenceIds: ["f0001"], inference: false },
    ], marketingPoints: [], limitations: [] };
    const input = { revision: 1, frames: [frame(0), frame(1)], texts: [], observations: [], durationMs: 1000, limitations: [] };
    const f = setup(result);
    const summary = await f.models.summarize(input);
    expect(summary.timeline.map(t => [t.startMs, t.endMs])).toEqual([[0, 0], [500, 500]]);
    expect(f.records.get("summary:1")?.receipt?.text).toBe(JSON.stringify(result));
    expect(await f.models.summarize(input)).toEqual(summary); expect(f.requests).toHaveLength(1);
    const forged = { ...result, timeline: [...result.timeline, { ...result.timeline[0], evidenceIds: ["f9999"] }] };
    await expect(setup(forged).models.summarize(input)).rejects.toThrow("INVALID_EVIDENCE_REFERENCE");
  });
  it("generates copy and all shots from the complete analysis once, then reuses the receipt", async () => {
    const shots = ["欢迎品尝咖啡。", "发现喜欢的味道。"].map(script => ({ durationSec: 15, script, visual: "咖啡店", action: "展示咖啡", camera: "中景" }));
    const f = setup({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "场景切入。" });
    const snapshot = { source: { platform: "bilibili" as const, canonicalUrl: "https://www.bilibili.com/video/BV1234567890" }, frames: [frame(0)], frameTexts: [], texts: [], observations: [{ description: "完整场景观察", frameIds: ["f0001"], uncertainty: "" }] };
    const draft = MarketingDraftSchema.parse({ copyMode: "rewrite", reference: snapshot.source.canonicalUrl });
    const result = await f.models.createCopy(draft, "zh", snapshot, 1);
    expect(result.draft.script).toBe(storyboardScript(shots)); expect(result.draft.storyboard).toEqual(shots);
    // Mimic PostgreSQL JSONB reordering, with identical semantic input.
    const restored = JSON.parse(JSON.stringify(snapshot, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
    await f.models.createCopy(draft, "zh", restored, 1);
    expect(f.requests).toHaveLength(1); expect(f.requests[0].messages[1].content).toContain("完整场景观察");
    expect(f.records.has("copy:1")).toBe(true);
  });
  it.each([402, 403])("records upstream balance rejection (%s) without fabricating usage or replaying", async status => {
    const finish = vi.fn(async () => {});
    const chat = vi.fn(async function* (): AsyncGenerator<ChatChunk> { throw Object.assign(new Error("secret balance details"), { status, code: "insufficient_user_quota" }); });
    const models = new AnalysisModels({ readFrame: async () => Uint8Array.from([255, 216, 255]), provider: async () => ({ chat }), ledger: { begin: async () => null, finish } });
    await expect(models.ocr(frame(0))).rejects.toThrow("MODEL_QUOTA");
    expect(chat).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith("ocr:f0001", { text: "", outcome: "rejected", errorCode: "MODEL_QUOTA" });
  });
  it.each([false, true])("carries ASR status and sampling gaps into copy without treating the analyzed video as a generation asset (speech=%s)", async completed => {
    const shots = ["欢迎品尝咖啡。", "发现喜欢的味道。"].map(script => ({ durationSec: 15, script, visual: "人物在咖啡店", action: "展示咖啡", camera: "中景" }));
    const f = setup({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "从场景切入。" });
    const snapshot: AnalysisSnapshot = {
      source: { platform: "local", canonicalUrl: "private-source", uploadId: "11111111-1111-4111-8111-111111111111" },
      frames: [], frameTexts: [], texts: [], observations: [],
      speech: completed ? { status: "completed", id: "a0001", text: "现磨咖啡", model: "asr" } : { status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" },
      coverage: { sampledFrames: 2, ocrFrames: 1, visualFrames: 1, omittedOcrFrameIds: ["f0002"], omittedVisualFrameIds: [], limitations: ["OCR_INCOMPLETE"] },
    };
    await f.models.createCopy(MarketingDraftSchema.parse({ copyMode: "rewrite" }), "zh", snapshot, 1);
    const [system, input] = f.requests[0].messages;
    expect(JSON.parse(input.content as string)).toMatchObject({ generateAudio: true, materials: { video: false }, evidence: { speech: snapshot.speech, limitations: ["OCR_INCOMPLETE"] } });
    expect(input.content).not.toContain("private-source");
    expect(input.content).not.toContain(snapshot.source.uploadId);
    expect(system.content).toContain(completed ? "fallible ASR source narration" : "No usable audio transcript is supplied");
  });
  it.each(["summary", "copy"] as const)("allows a complete %s response after two minutes without replaying it", async stage => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const draft = MarketingDraftSchema.parse({ copyMode: "rewrite", reference: "参考文案" });
    const shots = ["欢迎品尝咖啡。", "发现喜欢的味道。"].map(script => ({ durationSec: 15, script, visual: "咖啡店", action: "展示咖啡", camera: "中景" }));
    const response = stage === "copy" ? { shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "场景切入。" }
      : { summary: [], timeline: [], marketingPoints: [], limitations: [] };
    let receipt: ModelStepReceipt | undefined;
    const finish = vi.fn(async (_id: string, value: ModelStepReceipt) => { receipt = value; });
    const begin = vi.fn(async () => receipt ?? null);
    const chat = vi.fn(async function* (_messages, _tools, options) {
      await new Promise(resolve => setTimeout(resolve, 130000)); options?.signal?.throwIfAborted();
      yield { type: "text" as const, content: JSON.stringify(response) };
      yield { type: "done" as const, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 100 } };
    } satisfies LLMProvider["chat"]);
    const models = new AnalysisModels({ readFrame: async () => new Uint8Array(), ledger: { begin, finish }, provider: async () => ({ chat }) });
    const run = () => stage === "copy"
      ? models.createCopy(draft, "zh", { source: { platform: "bilibili", canonicalUrl: "https://www.bilibili.com/video/BV1234567890" }, frames: [], frameTexts: [], texts: [], observations: [] }, 1)
      : models.summarize({ revision: 1, frames: [], texts: [], observations: [], durationMs: 1000, limitations: [] });
    try {
      const result = run();
      const completed = expect(result).resolves.toMatchObject(stage === "copy" ? { draft: { storyboard: shots } } : response);
      await vi.advanceTimersByTimeAsync(130000); await completed;
      await run();
      expect(chat).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledWith(`${stage}:1`, expect.objectContaining({ outcome: "completed" }));
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  it.each(["deadline", "cancel"] as const)("stops a slow summary on %s and never automatically resubmits", async reason => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const controller = new AbortController(); let receipt: ModelStepReceipt | undefined;
    const chat = vi.fn(async function* (_messages, _tools, options) {
      options?.onResponseId?.("resp-slow-summary");
      yield { type: "text" as const, content: '{"summary":[' };
      await new Promise<void>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      });
    } satisfies LLMProvider["chat"]);
    const models = new AnalysisModels({ readFrame: async () => new Uint8Array(), provider: async () => ({ chat }), ledger: {
      begin: async () => receipt ?? null, finish: async (_id, value) => { receipt = value; },
    } });
    const run = () => models.summarize({ revision: 1, frames: [], texts: [], observations: [], durationMs: 1000, limitations: [] }, controller.signal);
    try {
      const rejected = expect(run()).rejects.toThrow("REQUEST_UNKNOWN");
      await vi.advanceTimersByTimeAsync(130000);
      expect(receipt).toBeUndefined();
      if (reason === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(170000);
      await rejected;
      expect(receipt).toMatchObject({ outcome: "request_unknown", responseId: "resp-slow-summary", text: '{"summary":[' });
      expect(receipt?.usage).toBeUndefined();
      await expect(models.summarize({ revision: 1, frames: [], texts: [], observations: [], durationMs: 1000, limitations: [] })).rejects.toThrow("REQUEST_UNKNOWN");
      expect(chat).toHaveBeenCalledOnce();
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  it("reuses a summary after database key reordering", async () => {
    const f = setup({ summary: [{ statement: "咖啡", evidenceIds: ["t0001"], inference: false }], timeline: [], marketingPoints: [], limitations: [] });
    const input = { revision: 1, frames: [frame(0)], texts: [{ id: "t0001", rawText: "咖啡", text: "咖啡", frameIds: ["f0001"], firstSeenMs: 0, lastSeenMs: 0 }], observations: [{ description: "咖啡", frameIds: ["f0001"], uncertainty: "" }], durationMs: 1000, limitations: [] };
    await f.models.summarize(input);
    const restored = JSON.parse(JSON.stringify(input, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
    await f.models.summarize({ ...input, texts: restored.texts, observations: restored.observations });
    expect(f.requests).toHaveLength(1);
  });
  it("requires credentials and one of the two selected models", () => {
    expect(() => userResponsesProvider("https://example.test/v1", "", "qwen3.8-max")).toThrow("MODEL_AUTH_REQUIRED");
    expect(() => userResponsesProvider("https://example.test/v1", "key", "other")).toThrow("MODEL_AUTH_REQUIRED");
  });
});

it("includes speech in synthesis, preserves ASR evidence, and reuses receipts after JSONB reorders speech fields", async () => {
  const speech = { status: "completed" as const, id: "a0001" as const, text: "测试录音设备，进入网站。", model: "qwen-audio-3.1-asr-flash" };
  const input = { revision: 1, frames: [], texts: [], observations: [], durationMs: 1000, limitations: [], speech };
  const result = { summary: [{ statement: speech.text, evidenceIds: ["a0001"], inference: false }], timeline: [], marketingPoints: [], limitations: [] };
  const f = setup(result);
  expect(await f.models.summarize(input)).toEqual(result);
  const restored = { ...input, speech: { model: speech.model, text: speech.text, id: speech.id, status: speech.status } };
  expect(await f.models.summarize(restored)).toEqual(result);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].messages[1].content).toContain(speech.text);
  const shots = ["欢迎品尝咖啡。", "发现喜欢的味道。"].map(script => ({ durationSec: 15, script, visual: "咖啡店", action: "展示咖啡", camera: "中景" }));
  const copy = setup({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "场景切入。" });
  // The analysis API accepts creation contexts only in rewrite mode.
  await copy.models.createCopy(MarketingDraftSchema.parse({ copyMode: "rewrite" }), "zh", { source: { platform: "bilibili", canonicalUrl: "fixture" }, frames: [], frameTexts: [], texts: [], observations: [], speech }, 1);
  expect(copy.requests[0].messages[1].content).toContain(speech.text);
  expect(copy.requests[0].messages[0].content).not.toContain("not audio");
});
