import { describe, expect, it, vi } from "vitest";
import { selectAnalysisFrames, type AnalysisSnapshot, type FrameEvidence } from "@lot-agent/core/marketing-analysis";
import type { Message } from "@lot-agent/core";
import { AnalysisModels, type ModelStepReceipt } from "./models.js";
import { analyzeSelectedFrames } from "./pipeline.js";
import { AnalysisError } from "./errors.js";

const frames: FrameEvidence[] = [0, 1].map(i => ({ id: `f000${i + 1}`, sourceHash: "a".repeat(64), sourcePts: String(i * 500), timeBase: "1/1000", ptsMs: i * 500, width: 640, height: 360, objectKey: `frame-000${i + 1}.jpg`, reasons: [] }));
const selection = { ...selectAnalysisFrames(frames, frames.map((_, i) => new Uint8Array(96 * 54).fill(i * 255))), durationMs: 1000 };
const initial = (): AnalysisSnapshot => ({ source: { platform: "douyin", canonicalUrl: "https://www.douyin.com/video/1234567", sourceHash: "a".repeat(64) }, frames: [], frameTexts: [], texts: [], observations: [] });

function parallelSelection() {
  const many = Array.from({ length: 24 }, (_, i) => ({ ...frames[0], id: `f${String(i + 1).padStart(4, "0")}`, ptsMs: i * 500, sourcePts: String(i * 500) }));
  return { frames: many, ocr: many, visual: many, durationMs: 12000,
    coverage: { sampledFrames: 24, ocrFrames: 24, visualFrames: 24, omittedOcrFrameIds: [], omittedVisualFrameIds: [], limitations: [] } };
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const emptySummary = () => ({ summary: [], timeline: [], marketingPoints: [], limitations: [] });

describe("parallel frame analysis", () => {
  it.each([undefined, { ocrConcurrency: 2, visualConcurrency: 1 }])("bounds parallel work, orders results, and summarizes only after both stages: %j", async settings => {
    vi.useFakeTimers();
    try {
      const selected = parallelSelection();
      let ocr = 0, visual = 0, peakOcr = 0, peakVisual = 0, writes = 0, peakWrites = 0, overlapping = false;
      let completedOcr = 0, completedVisual = 0;
      const snapshots: AnalysisSnapshot[] = [];
      const models = {
        ocr: vi.fn(async (frame: FrameEvidence) => {
          peakOcr = Math.max(peakOcr, ++ocr); overlapping ||= visual > 0;
          await delay(80 - Number(frame.id.slice(1)) % 8 * 5);
          ocr--; completedOcr++;
          return { frameId: frame.id, rawText: frame.id };
        }),
        observe: vi.fn(async (index: number, batch: FrameEvidence[]) => {
          peakVisual = Math.max(peakVisual, ++visual); overlapping ||= ocr > 0;
          await delay(50 - index * 10);
          visual--; completedVisual++;
          return [{ description: `batch ${index}`, frameIds: batch.map(f => f.id), uncertainty: "" }];
        }),
        summarize: vi.fn(async () => {
          expect([ocr, visual, completedOcr, completedVisual]).toEqual([0, 0, 24, 4]);
          return emptySummary();
        }),
      };
      const pending = analyzeSelectedFrames({ snapshot: initial(), selection: selected, revision: 1, ...settings,
        models: models as unknown as AnalysisModels, checkpoint: async snapshot => {
          peakWrites = Math.max(peakWrites, ++writes); await delay(1); snapshots.push(snapshot); writes--;
        } });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect([peakOcr, peakVisual, peakWrites, overlapping]).toEqual([settings?.ocrConcurrency ?? 8, settings?.visualConcurrency ?? 3, 1, true]);
      expect(result.frameTexts.map(t => t.frameId)).toEqual(selected.frames.map(f => f.id));
      expect(result.observations.map(o => o.description)).toEqual(["batch 0", "batch 1", "batch 2", "batch 3"]);
      expect(models.ocr).toHaveBeenCalledTimes(24); expect(models.observe).toHaveBeenCalledTimes(4); expect(models.summarize).toHaveBeenCalledOnce();
      expect(snapshots.at(-1)).toEqual(result);
    } finally { vi.useRealTimers(); }
  });

  it.each(["MODEL_QUOTA", "MODEL_RATE_LIMIT", "REQUEST_UNKNOWN"])("stops scheduling after %s while retaining in-flight work", async code => {
    vi.useFakeTimers();
    try {
      let saved = initial();
      const models = {
        ocr: vi.fn(async (frame: FrameEvidence) => {
          await delay(frame.id === "f0001" ? 5 : 30);
          if (frame.id === "f0001") throw new AnalysisError(code);
          return { frameId: frame.id, rawText: "保留已完成结果" };
        }),
        observe: vi.fn(async (index: number, batch: FrameEvidence[]) => { await delay(40); return [{ description: `batch ${index}`, frameIds: batch.map(f => f.id), uncertainty: "" }]; }),
        summarize: vi.fn(),
      };
      const outcome = analyzeSelectedFrames({ snapshot: initial(), selection: parallelSelection(), revision: 1, ocrConcurrency: 2, visualConcurrency: 2,
        models: models as unknown as AnalysisModels, checkpoint: async snapshot => { saved = snapshot; } }).catch(error => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ code });
      expect(models.ocr).toHaveBeenCalledTimes(2); expect(models.observe).toHaveBeenCalledTimes(2); expect(models.summarize).not.toHaveBeenCalled();
      expect(saved.frameTexts).toHaveLength(1); expect(saved.observations).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("cancels both active stages without starting more calls or a summary", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const stop = async (_input: unknown, signal?: AbortSignal) => { await delay(20); signal?.throwIfAborted(); return { frameId: "f0001", rawText: "" }; };
      const models = { ocr: vi.fn(stop), observe: vi.fn(async (_i, _frames, signal) => { await stop(undefined, signal); return []; }), summarize: vi.fn() };
      const outcome = analyzeSelectedFrames({ snapshot: initial(), selection: parallelSelection(), revision: 1, ocrConcurrency: 2, visualConcurrency: 2,
        models: models as unknown as AnalysisModels, checkpoint: async () => {}, signal: controller.signal }).catch(error => error);
      setTimeout(() => controller.abort(), 5);
      await vi.runAllTimersAsync();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(models.ocr).toHaveBeenCalledTimes(2); expect(models.observe).toHaveBeenCalledTimes(2); expect(models.summarize).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("analysis stage checkpoints", () => {
  it("retains OCR on a failed summary; a corrected revision only pays for a new summary", async () => {
    const calls: { model: string; messages: Message[] }[] = [];
    const saved = new Map<string, ModelStepReceipt>();
    let snapshot = initial(); let firstSummary = true;
    const model = new AnalysisModels({
      readFrame: async () => Uint8Array.from([255, 216, 255, 0]),
      ledger: { begin: async id => saved.get(id) ?? null, finish: async (id, receipt) => { saved.set(id, structuredClone(receipt)); } },
      provider: async modelId => ({ async *chat(messages) {
        calls.push({ model: modelId, messages });
        const system = String(messages[0].content);
        let value: unknown; let finishReason = "stop";
        if (modelId === "deepseek-v4.1-flash") value = { text: "99元" };
        else if (system.startsWith("Analyze")) value = { observations: [{ description: "product", frameIds: ["f0001", "f0002"], uncertainty: "" }] };
        else {
          value = { summary: [{ statement: "Product", evidenceIds: ["t0001"], inference: false }], timeline: [], marketingPoints: [], limitations: [] };
          if (firstSummary) { firstSummary = false; finishReason = "length"; }
        }
        yield { type: "text", content: JSON.stringify(value) };
        yield { type: "done", finishReason, usage: { promptTokens: 100, completionTokens: 40 } };
      } }),
    });
    const checkpoint = async (next: AnalysisSnapshot) => { snapshot = structuredClone(next); };
    await expect(analyzeSelectedFrames({ snapshot, selection, revision: 1, models: model, checkpoint })).rejects.toThrow("MODEL_STEP_FAILED");
    expect(snapshot.frameTexts).toHaveLength(2); expect(snapshot.texts[0].rawText).toBe("99元"); expect(snapshot.summary).toBeUndefined();
    const previousCalls = calls.length;
    snapshot.texts[0].text = "199元";
    const completed = await analyzeSelectedFrames({ snapshot, selection, revision: 2, models: model, checkpoint });
    expect(calls).toHaveLength(previousCalls + 1);
    expect(calls.at(-1)?.model).toBe("kimi-k3");
    expect(calls.at(-1)?.messages[1].content).toContain('"text":"199元"');
    expect(calls.at(-1)?.messages[1].content).not.toContain("rawText");
    expect(completed.summaryRevision).toBe(2); expect(completed.texts[0].rawText).toBe("99元");
  });
  it("stops before further paid requests after cancellation", async () => {
    const abort = new AbortController(); abort.abort();
    let calls = 0;
    const models = new AnalysisModels({ ledger: { begin: async () => { calls++; return null; }, finish: async () => {} }, provider: async () => { throw new Error("must not call"); }, readFrame: async () => new Uint8Array() });
    await expect(analyzeSelectedFrames({ snapshot: initial(), selection, revision: 1, models, checkpoint: async () => {}, signal: abort.signal })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

it("automatically synthesizes the remaining evidence after known OCR failures without retrying them", async () => {
  const originalSelection = structuredClone(selection);
  const calls: string[] = []; const receipts = new Map<string, ModelStepReceipt>();
  const models = new AnalysisModels({
    readFrame: async () => Uint8Array.from([255, 216, 255]),
    ledger: { begin: async id => receipts.get(id) ?? null, finish: async (id, value) => { receipts.set(id, structuredClone(value)); } },
    provider: async model => ({ async *chat(messages) {
      const system = String(messages[0].content); calls.push(model);
      const output = model === "deepseek-v4.1-flash" ? "broken JSON"
        : JSON.stringify(system.startsWith("Analyze") ? { observations: [{ description: "产品", frameIds: ["f0001", "f0002"], uncertainty: "" }] }
          : { summary: [{ statement: "展示产品", evidenceIds: ["f0001"], inference: false }], timeline: [], marketingPoints: [], limitations: [] });
      yield { type: "text", content: output }; yield { type: "done", finishReason: "stop", usage: { promptTokens: 2, completionTokens: 2 } };
    } }),
  });
  const result = await analyzeSelectedFrames({ snapshot: initial(), selection, revision: 1, models, checkpoint: async () => {} });
  expect(calls).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash", "kimi-k3", "kimi-k3"]);
  expect(result.summary?.summary[0].statement).toBe("展示产品");
  expect(result.summary?.limitations).toContain("OCR_INCOMPLETE");
  expect(result.coverage?.omittedOcrFrameIds).toEqual(["f0001", "f0002"]);
  expect(result.texts).toEqual([]);
  expect(selection).toEqual(originalSelection);
  const replay = await analyzeSelectedFrames({ snapshot: result, selection, revision: 1, models, checkpoint: async () => {} });
  expect(calls).toHaveLength(4);
  expect(replay.summary?.limitations).toContain("OCR_INCOMPLETE");
});
