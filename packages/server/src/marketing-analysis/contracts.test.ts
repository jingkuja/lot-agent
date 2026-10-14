import { expect, it } from "vitest";
import { analysisConfig } from "./config.js";
import { referencePreview } from "./apply.js";
import { validReceiptUsage } from "./ledger.js";
import type { AnalysisSnapshot } from "@lot-agent/core/marketing-analysis";

it("requires isolation configuration but no local budget or prices", () => {
  expect(analysisConfig({}).enabled).toBe(false);
  expect(() => analysisConfig({ MARKETING_ANALYSIS_ENABLED: "1" })).toThrow("ANALYSIS_CONFIG_REQUIRED");
  const env = { MARKETING_ANALYSIS_ENABLED: "1", YTDLP_VERSION: "2026.07.04", SECRET_MASTER_KEY: "fixture" };
  expect(analysisConfig(env)).toEqual({ enabled: true, downloaderVersion: "2026.07.04", concurrency: 2 });
  expect(analysisConfig({ ...env, MARKETING_ANALYSIS_BUDGET_CNY: "invalid", MARKETING_ANALYSIS_PRICING: "invalid" })).not.toHaveProperty("budget");
  expect(() => analysisConfig({ ...env, MARKETING_ANALYSIS_CONCURRENCY: "5" })).toThrow("ANALYSIS_CONFIG_REQUIRED");
});

it("previews only selected, known evidence and preserves corrected text", () => {
  const snapshot: AnalysisSnapshot = { source: { platform: "bilibili", canonicalUrl: "fixture" }, frames: [], frameTexts: [], observations: [],
    texts: [{ id: "t0001", rawText: "99元", text: "199元", firstSeenMs: 0, lastSeenMs: 500, frameIds: ["f0001"] }],
    summary: { summary: [{ statement: "Display price", evidenceIds: ["t0001"], inference: false }], timeline: [], marketingPoints: [], limitations: [] } };
  expect(referencePreview(snapshot, ["t0001"])).toContain("199元");
  expect(() => referencePreview(snapshot, ["t9999"])).toThrow("INVALID_EVIDENCE_REFERENCE");
  expect(() => referencePreview(snapshot, ["t0001", "t0001"])).toThrow("INVALID_EVIDENCE_REFERENCE");
  expect(() => referencePreview(snapshot, [])).toThrow("INVALID_EVIDENCE_REFERENCE");
  expect(() => referencePreview({ ...snapshot, texts: [{ ...snapshot.texts[0], text: "长".repeat(6000) }] }, ["t0001"])).toThrow("REFERENCE_TOO_LONG");
});

it("never converts missing or invalid usage into a known zero bill", () => {
  expect(validReceiptUsage({ text: "", outcome: "request_unknown" })).toBeFalsy();
  expect(validReceiptUsage({ text: "", outcome: "failed", usage: { promptTokens: -1, completionTokens: 0 } })).toBe(false);
  expect(validReceiptUsage({ text: "", outcome: "failed", usage: { promptTokens: 0, completionTokens: 0 } })).toBe(true);
});
