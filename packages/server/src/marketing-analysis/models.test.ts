import { describe, expect, it, vi } from "vitest";
import type { ChatChunk, LLMProvider, Message } from "@lot-agent/core";
import type { FrameEvidence } from "@lot-agent/core/marketing-analysis";
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
  it("requires credentials and one of the two selected models", () => {
    expect(() => userResponsesProvider("https://example.test/v1", "", "kimi-k3")).toThrow("MODEL_AUTH_REQUIRED");
    expect(() => userResponsesProvider("https://example.test/v1", "key", "other")).toThrow("MODEL_AUTH_REQUIRED");
  });
});
