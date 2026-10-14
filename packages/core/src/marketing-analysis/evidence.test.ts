import { describe, expect, it } from "vitest";
import { mergeScreenText, validateObservation, validateSummary, grayDifference, selectAnalysisFrames, type FrameEvidence } from "./index.js";

const frame = (i: number): FrameEvidence => ({ id: `f${String(i + 1).padStart(4, "0")}`, sourceHash: "a".repeat(64), sourcePts: String(i * 500), timeBase: "1/1000", ptsMs: i * 500, width: 1280, height: 720, objectKey: `${i}.jpg`, reasons: [] });
const frames = Array.from({ length: 7 }, (_, i) => frame(i));

describe("screen text evidence", () => {
  it("preserves prices, negations and repeated later occurrences", () => {
    const raw = ["仅99元", "仅99元", "仅999元", "不包邮", "包邮", "", "仅99元"];
    const texts = mergeScreenText(frames, raw.map((rawText, i) => ({ frameId: frames[i].id, rawText })));
    expect(texts.map(t => t.text)).toEqual(["仅99元", "仅999元", "不包邮", "包邮", "仅99元"]);
    expect(texts[0]).toMatchObject({ firstSeenMs: 0, lastSeenMs: 500, frameIds: ["f0001", "f0002"] });
    expect(texts.at(-1)?.firstSeenMs).toBe(3000);
  });
  it("missing OCR breaks the observation interval", () => {
    expect(mergeScreenText(frames.slice(0, 3), [{ frameId: "f0001", rawText: "99" }, { frameId: "f0003", rawText: "99" }])).toHaveLength(2);
  });
  it("rejects duplicate and nonexistent OCR references", () => {
    expect(() => mergeScreenText(frames, [{ frameId: "f0999", rawText: "text" }])).toThrow("INVALID_OCR_REFERENCE");
    expect(() => mergeScreenText(frames, [{ frameId: "f0001", rawText: "a" }, { frameId: "f0001", rawText: "b" }])).toThrow("INVALID_OCR_REFERENCE");
  });
});

describe("evidence validation", () => {
  const statement = { statement: "Visible product", evidenceIds: ["f0001"], inference: false };
  const result = { summary: [statement], timeline: [{ ...statement, startMs: 0, endMs: 500 }], marketingPoints: [], limitations: ["No audio"] };
  it("accepts cited findings and empty unsupported categories", () => expect(validateSummary(result, frames, [], 3500)).toEqual(result));
  it("rejects invented ids, invalid times and evidence outside its interval", () => {
    expect(() => validateSummary({ ...result, summary: [{ ...statement, evidenceIds: ["f0999"] }] }, frames, [], 3500)).toThrow("INVALID_EVIDENCE_REFERENCE");
    expect(() => validateSummary({ ...result, timeline: [{ ...statement, startMs: 1000, endMs: 1500 }] }, frames, [], 3500)).toThrow("EVIDENCE_OUTSIDE_TIMELINE");
    expect(() => validateSummary(result, frames, [], 400)).toThrow("INVALID_TIMELINE_RANGE");
    expect(() => validateSummary({ ...result, timeline: [{ ...statement, startMs: 0, endMs: 37000 }] }, frames, [], 37100)).toThrow("EVIDENCE_OUTSIDE_TIMELINE");
  });
  it("validates batch order and rejects unsupported confidence fields", () => {
    expect(() => validateObservation({ description: "产品", frameIds: ["f0002", "f0001"], uncertainty: "" }, frames)).toThrow("INVALID_FRAME_ORDER");
    expect(() => validateObservation({ description: "产品", frameIds: ["f0001"], uncertainty: "", confidence: 0.9 }, frames)).toThrow();
  });
});

describe("candidate selection", () => {
  it("finds a changed local text area against a static background", () => {
    const a = new Uint8Array(96 * 54); const b = a.slice();
    for (let y = 38; y < 43; y++) for (let x = 40; x < 47; x++) b[y * 96 + x] = 255;
    expect(grayDifference(a, b).global).toBeLessThan(0.01);
    expect(grayDifference(a, b).local).toBeGreaterThan(0.025);
    const result = selectAnalysisFrames(frames.slice(0, 4), [a, a, b, b]);
    expect(result.ocr.map(f => f.id)).toContain("f0002");
    expect(result.ocr.find(f => f.id === "f0003")?.reasons).toContain("change");
  });
  it("caps cost while retaining start, end and explicit missing coverage", () => {
    const many = Array.from({ length: 361 }, (_, i) => frame(i));
    const result = selectAnalysisFrames(many, many.map((_, i) => new Uint8Array(96 * 54).fill(i % 2 ? 255 : 0)));
    expect(result.ocr).toHaveLength(120); expect(result.visual).toHaveLength(48);
    expect(result.ocr[0].id).toBe("f0001"); expect(result.ocr.at(-1)?.id).toBe("f0361");
    expect(result.coverage.omittedOcrFrameIds).toHaveLength(241);
    expect(result.coverage.limitations).toContain("OCR_BUDGET_EXHAUSTED");
  });
});
