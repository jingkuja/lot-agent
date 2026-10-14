import "../src/load-env.js";
import { readFile, writeFile, mkdir, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAnalysisSource } from "../src/marketing-analysis/download.js";
import { extractAnalysisFrames } from "../src/marketing-analysis/frames.js";
import { localProbeDownloadRuntime, localProbeRunner } from "../src/marketing-analysis/local-probe.js";
import { AnalysisModels, userResponsesProvider } from "../src/marketing-analysis/models.js";
import { ProbeCallLedger } from "../src/marketing-analysis/probe-ledger.js";
import { failedProbeOcrFrames } from "../src/marketing-analysis/probe-resume.js";
import { analyzeSelectedFrames } from "../src/marketing-analysis/pipeline.js";
import { readAnalysisFile } from "../src/marketing-analysis/private-files.js";
import { loadLlmConfig } from "../src/config.js";
import { ANALYSIS_VERSION, type AnalysisSnapshot, type FrameEvidence } from "@lot-agent/core/marketing-analysis";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = resolve(process.env.MARKETING_ANALYSIS_LOCAL_DIR ?? "");
const mode = process.argv[2];
if (!directory.startsWith(join(root, "data/marketing-analysis-probes/")) || !["download", "analyze"].includes(mode)) {
  console.error("Usage: MARKETING_ANALYSIS_LOCAL_DIR=<private data/marketing-analysis-probes/run directory> YTDLP_VERSION=<installed version> pnpm check:marketing-analysis:local download|analyze. Place the authorized share link in source.txt. Analyze additionally requires MARKETING_ANALYSIS_LOCAL_MODEL_CALLS=1, uses this operator's OPENAI_API_KEY, and defaults to 6 OCR / 6 visual frames.");
  process.exit(1);
}
const controller = new AbortController();
process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
await mkdir(directory, { recursive: true, mode: 0o700 });
async function save(name: string, value: unknown) { await writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 }); }
const lock = await open(join(directory, ".probe.lock"), "wx", 0o600);
try {
  const sourceDir = join(directory, "source");
  if (mode === "download") {
    const result = await downloadAnalysisSource({ shareText: await readFile(join(directory, "source.txt"), "utf8"), directory: sourceDir,
      bridgePath: join(root, "deploy/media-analysis-proxy-bridge.py"), expectedDownloaderVersion: process.env.YTDLP_VERSION ?? "", signal: controller.signal }, async (directory, signal) => {
        const runtime = await localProbeDownloadRuntime(directory, signal);
        return { ...runtime, runner: { async run(command, args, signal) {
          try {
            const result = await runtime.runner.run(command, args, signal);
            if (command === "yt-dlp" && args.includes("--dump-single-json")) await save("resolved-metadata.json", JSON.parse(result.stdout));
            return result;
          }
          catch (error) { await save("process-failure.json", { command, diagnostic: (error as { diagnostic?: string }).diagnostic }); throw error; }
        } } };
      });
    await save("download.json", result);
    const selection = await extractAnalysisFrames({ directory: sourceDir, source: result.source, runner: localProbeRunner(sourceDir), signal: controller.signal });
    await save("frames.json", selection);
    console.log(JSON.stringify({ status: "downloaded", platform: result.source.platform, bytes: result.bytes, durationMs: selection.durationMs,
      candidates: selection.frames.length, ocrFrames: selection.ocr.length, visualFrames: selection.visual.length, report: directory }));
    await rm(join(directory, "failure.json"), { force: true });
  } else {
    if (process.env.MARKETING_ANALYSIS_LOCAL_MODEL_CALLS !== "1") throw new Error("EXPLICIT_MODEL_PROBE_REQUIRED");
    const config = await loadLlmConfig(root);
    if (!config.openai.apiKey || !config.openai.baseUrl) throw new Error("PROBE_OPERATOR_KEY_REQUIRED");
    const ocrCap = Number(process.env.MARKETING_ANALYSIS_LOCAL_MAX_OCR ?? 6);
    const visualCap = Number(process.env.MARKETING_ANALYSIS_LOCAL_MAX_VISUAL ?? 6);
    if (![ocrCap, visualCap].every(n => Number.isInteger(n) && n >= 2) || ocrCap > 120 || visualCap > 48) throw new Error("INVALID_PROBE_LIMITS");
    const download = JSON.parse(await readFile(join(directory, "download.json"), "utf8"));
    const selection: Awaited<ReturnType<typeof extractAnalysisFrames>> = JSON.parse(await readFile(join(directory, "frames.json"), "utf8"));
    function cap(frames: FrameEvidence[], max: number) {
      if (frames.length <= max) return frames;
      const indices = new Set(Array.from({ length: max }, (_, i) => Math.round(i * (frames.length - 1) / (max - 1))));
      return frames.filter((_, i) => indices.has(i));
    }
    const ocr = cap(selection.ocr, ocrCap); const visual = cap(selection.visual, visualCap);
    const limited = ocr.length < selection.ocr.length || visual.length < selection.visual.length;
    selection.coverage = { ...selection.coverage, ocrFrames: ocr.length, visualFrames: visual.length,
      omittedOcrFrameIds: [...new Set([...selection.coverage.omittedOcrFrameIds, ...selection.ocr.filter(f => !ocr.includes(f)).map(f => f.id)])],
      omittedVisualFrameIds: [...new Set([...selection.coverage.omittedVisualFrameIds, ...selection.visual.filter(f => !visual.includes(f)).map(f => f.id)])],
      limitations: [...selection.coverage.limitations, ...(limited ? ["LOCAL_PROBE_FRAME_LIMIT"] : [])] };
    selection.ocr = ocr; selection.visual = visual;
    const run = `analysis-${ocrCap}-${visualCap}`;
    await mkdir(join(directory, run), { mode: 0o700, recursive: true });
    const context = { version: ANALYSIS_VERSION, sourceHash: download.source.sourceHash, credential: createHash("sha256").update(config.openai.apiKey).digest("hex"), ocrCap, visualCap, baseUrl: config.openai.baseUrl };
    const contextFile = join(directory, run, "context.json");
    try { const previous = JSON.parse(await readFile(contextFile, "utf8")); if (JSON.stringify(previous) !== JSON.stringify(context)) throw new Error("PROBE_CONTEXT_CHANGED"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await save(`${run}/context.json`, context); }
    const ledger = new ProbeCallLedger(join(directory, run, "receipts"), async () => {}, { calls: ocr.length + Math.ceil(visual.length / 6) + 1, images: ocr.length + visual.length });
    const allowGaps = process.env.MARKETING_ANALYSIS_LOCAL_SKIP_FAILED_OCR === "1";
    let failedOcr = failedProbeOcrFrames(await ledger.records(), allowGaps);
    const models = new AnalysisModels({ ledger, provider: async id => {
      const provider = userResponsesProvider(config.openai.baseUrl!, config.openai.apiKey, id);
      return { async *chat(messages, tools, opts) {
        try { yield* provider.chat(messages, tools, opts); }
        catch (error) {
          const e = error as { status?: number; code?: string; type?: string; error?: { message?: string }; message?: string; request_id?: string };
          await save(`${run}/gateway-failure.json`, { model: id, status: e.status, code: e.code, type: e.type, requestId: e.request_id, message: e.error?.message ?? e.message });
          throw error;
        }
      } };
    }, readFrame: frame => readAnalysisFile(sourceDir, frame.objectKey, 4 * 1024 * 1024) });
    let snapshot: AnalysisSnapshot = { source: download.source, frames: [], frameTexts: [], texts: [], observations: [] };
    try { snapshot = JSON.parse(await readFile(join(directory, run, "snapshot.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let result: AnalysisSnapshot;
    for (;;) {
      const currentSelection = { ...selection, ocr: selection.ocr.filter(frame => !failedOcr.includes(frame.id)), coverage: {
        ...selection.coverage, ocrFrames: selection.ocr.length - failedOcr.filter(id => selection.ocr.some(frame => frame.id === id)).length,
        omittedOcrFrameIds: [...new Set([...selection.coverage.omittedOcrFrameIds, ...failedOcr])],
        limitations: [...selection.coverage.limitations, ...(failedOcr.length ? ["MODEL_OCR_FAILED"] : [])],
      } };
      try {
        result = await analyzeSelectedFrames({ snapshot, selection: currentSelection, revision: 1, models, signal: controller.signal,
          checkpoint: async (value, stage) => { await save(`${run}/snapshot.json`, value); snapshot = value; console.log(JSON.stringify({ stage, ocr: value.frameTexts.length, observations: value.observations.length, failedOcr: failedOcr.length })); } });
        break;
      } catch (error) {
        const nextFailed = failedProbeOcrFrames(await ledger.records(), allowGaps);
        // A known failed OCR frame may be left as an explicit gap. No failed
        // request is replayed, and the original total call/image cap remains.
        if (nextFailed.length <= failedOcr.length || controller.signal.aborted) throw error;
        failedOcr = nextFailed;
      }
    }
    const receipts = await ledger.records();
    const usage = receipts.map(r => ({ stepId: r.stepId, model: r.model, responseId: r.receipt?.responseId, outcome: r.receipt?.outcome, usage: r.receipt?.usage }));
    await save(`${run}/report.json`, { status: failedOcr.length ? "completed_with_gaps" : "completed", snapshot: result, usage, limited, failedOcrFrameIds: failedOcr, billing: "Operator environment credential; real gateway usage retained. Monetary cost is not inferred from unknown price/discount units." });
    console.log(JSON.stringify({ status: "analyzed", limited, calls: receipts.length, ocrFrames: result.frameTexts.length, failedOcr: failedOcr.length, visualFrames: visual.length, report: join(directory, run, "report.json") }));
    await rm(join(directory, "failure.json"), { force: true });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "PROBE_FAILED";
  const code = /^[A-Z][A-Z_]+$/.test(message) ? message : "PROBE_FAILED";
  await save("failure.json", { code, diagnostic: (error as { diagnostic?: string }).diagnostic });
  console.error(JSON.stringify({ status: "failed", code, report: directory })); process.exitCode = 1;
} finally { await lock.close(); await rm(join(directory, ".probe.lock"), { force: true }); }
