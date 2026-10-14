import { describe, expect, it } from "vitest";
import { failedProbeOcrFrames } from "./probe-resume.js";

const usage = { promptTokens: 713, completionTokens: 8192 };
describe("operator continuation with OCR gaps", () => {
  it("requires an explicit choice and only skips known failed OCR", () => {
    const rows = [{ stepId: "ocr:f0035", receipt: { text: "", outcome: "failed" as const, usage } }];
    expect(() => failedProbeOcrFrames(rows, false)).toThrow("MODEL_STEP_FAILED");
    expect(failedProbeOcrFrames(rows, true)).toEqual(["f0035"]);
    expect(() => failedProbeOcrFrames([{ ...rows[0], stepId: "visual:0" }], true)).toThrow("MODEL_STEP_FAILED");
    expect(rows[0].receipt.outcome).toBe("failed");
  });
  it("blocks any unresolved call or unknown usage before further requests", () => {
    expect(() => failedProbeOcrFrames([{ stepId: "ocr:f0001" }], true)).toThrow("REQUEST_UNKNOWN");
    expect(() => failedProbeOcrFrames([{ stepId: "ocr:f0001", receipt: { text: "", outcome: "request_unknown", usage } }], true)).toThrow("REQUEST_UNKNOWN");
    expect(() => failedProbeOcrFrames([{ stepId: "ocr:f0001", receipt: { text: "", outcome: "failed" } }], true)).toThrow("MODEL_USAGE_UNKNOWN");
  });
});
