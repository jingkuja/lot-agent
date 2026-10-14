import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ANALYSIS_VERSION } from "@lot-agent/core/marketing-analysis";
import { runAnalysis } from "./runtime.js";
import { downloadAnalysisSource } from "./download.js";
import { extractAnalysisFrames } from "./frames.js";
import { analyzeSelectedFrames } from "./pipeline.js";
import type { AnalysisMediaRuntime } from "./media-runtime.js";

vi.mock("./download.js", () => ({ downloadAnalysisSource: vi.fn() }));
vi.mock("./frames.js", () => ({ extractAnalysisFrames: vi.fn() }));
vi.mock("./pipeline.js", () => ({ analyzeSelectedFrames: vi.fn() }));

it("uses the Worker-selected sandbox for download and decoding before running model analysis", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lot-runtime-test-"));
  const source = { platform: "bilibili" as const, canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD" };
  const downloaded = { ...source, mediaKey: "source.mp4", sourceHash: "a".repeat(64) };
  const signal = new AbortController().signal;
  const lease = { id: "analysis", ownerId: "owner", token: "lease", revision: 1 };
  const runner = { run: vi.fn() };
  const mediaRuntime: AnalysisMediaRuntime = { downloadRuntime: vi.fn(), decoderRunner: vi.fn(() => runner) };
  const checkpoint = vi.fn();
  const deps = {
    mediaRuntime,
    store: {
      row: vi.fn(async () => ({ pipeline_version: ANALYSIS_VERSION, mode: "all", selection: null,
        snapshot: { source, frames: [], frameTexts: [], observations: [], texts: [] } })),
      pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
      sourceText: vi.fn(async () => source.canonicalUrl), checkpoint,
    },
    storage: { directory: vi.fn(async () => directory) },
    db: { getUserApiKey: vi.fn(async () => "fixture-key") },
    hub: { listModels: vi.fn(async () => ({ llm: ["deepseek-v4.1-flash", "kimi-k3"] })) },
    config: { downloaderVersion: "2026.07.04" }, baseUrl: "https://gateway.example.test/v1", bridgePath: "/bridge.py",
  } as unknown as Parameters<typeof runAnalysis>[2];
  vi.mocked(downloadAnalysisSource).mockResolvedValue({ source: downloaded, bytes: 1, transferredBytes: 1 });
  vi.mocked(extractAnalysisFrames).mockResolvedValue({ frames: [], ocr: [], visual: [], durationMs: 1000,
    coverage: { sampledFrames: 0, ocrFrames: 0, visualFrames: 0, omittedOcrFrameIds: [], omittedVisualFrameIds: [], limitations: [] } });
  try {
    await runAnalysis(lease, signal, deps);
    expect(downloadAnalysisSource).toHaveBeenCalledWith(expect.objectContaining({ directory, signal, expectedDownloaderVersion: "2026.07.04" }), mediaRuntime.downloadRuntime);
    expect(mediaRuntime.decoderRunner).toHaveBeenCalledWith(directory);
    expect(extractAnalysisFrames).toHaveBeenCalledWith({ directory, source: expect.objectContaining(downloaded), runner, signal });
    expect(checkpoint).toHaveBeenCalledWith(lease, expect.anything(), "downloaded");
    expect(analyzeSelectedFrames).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, signal }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
