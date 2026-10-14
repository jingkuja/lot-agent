import { describe, expect, it } from "vitest";
import { selectAnalysisFrames, type AnalysisSnapshot, type FrameEvidence } from "@lot-agent/core/marketing-analysis";
import type { Message } from "@lot-agent/core";
import { AnalysisModels, type ModelStepReceipt } from "./models.js";
import { analyzeSelectedFrames } from "./pipeline.js";

const frames: FrameEvidence[] = [0, 1].map(i => ({ id: `f000${i + 1}`, sourceHash: "a".repeat(64), sourcePts: String(i * 500), timeBase: "1/1000", ptsMs: i * 500, width: 640, height: 360, objectKey: `frame-000${i + 1}.jpg`, reasons: [] }));
const selection = { ...selectAnalysisFrames(frames, frames.map((_, i) => new Uint8Array(96 * 54).fill(i * 255))), durationMs: 1000 };
const initial = (): AnalysisSnapshot => ({ source: { platform: "douyin", canonicalUrl: "https://www.douyin.com/video/1234567", sourceHash: "a".repeat(64) }, frames: [], frameTexts: [], texts: [], observations: [] });

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
