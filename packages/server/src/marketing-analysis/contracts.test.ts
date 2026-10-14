import { expect, it } from "vitest";
import { analysisConfig } from "./config.js";
import { referencePreview } from "./apply.js";
import { validReceiptUsage } from "./ledger.js";
import type { AnalysisSnapshot } from "@lot-agent/core/marketing-analysis";

it("requires explicit pricing, encrypted storage and a pinned downloader when enabled", () => {
  expect(analysisConfig({}).enabled).toBe(false);
  expect(() => analysisConfig({ MARKETING_ANALYSIS_ENABLED: "1" })).toThrow("ANALYSIS_CONFIG_REQUIRED");
  const env = { MARKETING_ANALYSIS_ENABLED: "1", MARKETING_ANALYSIS_BUDGET_CNY: "2", YTDLP_VERSION: "2026.07.04", SECRET_MASTER_KEY: "fixture" };
  expect(() => analysisConfig(env)).toThrow("ANALYSIS_PRICING_REQUIRED");
  const prices = { "deepseek-v4.1-flash": { inputPrice: 0.001, outputPrice: 0.002 }, "kimi-k3": { inputPrice: 0.002, outputPrice: 0.003 } };
  expect(analysisConfig({ ...env, MARKETING_ANALYSIS_PRICING: JSON.stringify(prices) }).pricing[1].inputPrice).toBe(0.002);
  expect(() => analysisConfig({ ...env, MARKETING_ANALYSIS_PRICING: JSON.stringify({ ...prices, "kimi-k3": { inputPrice: 0, outputPrice: 0 } }) })).toThrow("ANALYSIS_PRICING_REQUIRED");
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
