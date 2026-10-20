import { expect, it } from "vitest";
import { analysisConfig } from "./config.js";
import { validReceiptUsage } from "./ledger.js";

it("requires isolation configuration but no local budget or prices", () => {
  expect(analysisConfig({}).enabled).toBe(false);
  expect(() => analysisConfig({ MARKETING_ANALYSIS_ENABLED: "1" })).toThrow("ANALYSIS_CONFIG_REQUIRED");
  const env = { MARKETING_ANALYSIS_ENABLED: "1", YTDLP_VERSION: "2026.07.04", SECRET_MASTER_KEY: "fixture" };
  expect(analysisConfig(env)).toEqual({ enabled: true, downloaderVersion: "2026.07.04", concurrency: 2, ocrConcurrency: 8, visualConcurrency: 3, decodeThreads: 4 });
  expect(analysisConfig({ ...env, MARKETING_ANALYSIS_BUDGET_CNY: "invalid", MARKETING_ANALYSIS_PRICING: "invalid" })).not.toHaveProperty("budget");
  expect(() => analysisConfig({ ...env, MARKETING_ANALYSIS_CONCURRENCY: "5" })).toThrow("ANALYSIS_CONFIG_REQUIRED");
  expect(analysisConfig({ ...env, MARKETING_ANALYSIS_OCR_CONCURRENCY: "16", MARKETING_ANALYSIS_VISUAL_CONCURRENCY: "4", MARKETING_ANALYSIS_DECODE_THREADS: "8" }))
    .toMatchObject({ ocrConcurrency: 16, visualConcurrency: 4, decodeThreads: 8 });
  for (const [key, max] of [["MARKETING_ANALYSIS_OCR_CONCURRENCY", 16], ["MARKETING_ANALYSIS_VISUAL_CONCURRENCY", 4], ["MARKETING_ANALYSIS_DECODE_THREADS", 8]] as const) {
    for (const invalid of ["", "0", "1.5", "many", String(max + 1)]) expect(() => analysisConfig({ ...env, [key]: invalid })).toThrow("ANALYSIS_CONFIG_REQUIRED");
  }
});

it("never converts missing or invalid usage into a known zero bill", () => {
  expect(validReceiptUsage({ text: "", outcome: "request_unknown" })).toBeFalsy();
  expect(validReceiptUsage({ text: "", outcome: "failed", usage: { promptTokens: -1, completionTokens: 0 } })).toBe(false);
  expect(validReceiptUsage({ text: "", outcome: "failed", usage: { promptTokens: 0, completionTokens: 0 } })).toBe(true);
});
