import { summaryInput, updateAnalysisCoverage } from "./summary-input.js";
import { AnalysisError } from "./errors.js";
import { analysisParallelism } from "./config.js";
import { ANALYSIS_LIMITS, mergeScreenText, type AnalysisSnapshot, type FrameText } from "@lot-agent/core/marketing-analysis";
import type { AnalysisModels } from "./models.js";
import type { extractAnalysisFrames } from "./frames.js";

/** Reusable local/model stages. The production job layer must supply durable
 * checkpoints and a ledger; this deliberately does not create an HTTP task or
 * silently run a downloader outside its isolated environment. */
export async function analyzeSelectedFrames(input: {
  snapshot: AnalysisSnapshot;
  selection: Awaited<ReturnType<typeof extractAnalysisFrames>>;
  revision: number;
  ocrConcurrency?: number;
  visualConcurrency?: number;
  models: AnalysisModels;
  checkpoint(snapshot: AnalysisSnapshot, stage: string): Promise<void>;
  prepareSummary?(snapshot: AnalysisSnapshot): Promise<ReturnType<typeof summaryInput>>;
  signal?: AbortSignal;
}) {
  const parallelism = analysisParallelism(input);
  const snapshot: AnalysisSnapshot = structuredClone(input.snapshot);
  snapshot.frames = input.selection.frames; snapshot.coverage = structuredClone(input.selection.coverage);
  snapshot.source.durationMs = input.selection.durationMs;
  if (snapshot.speech?.status === "completed") snapshot.coverage.limitations = snapshot.coverage.limitations.filter(value => value !== "NO_AUDIO_ANALYSIS");
  let writing = Promise.resolve();
  const save = (stage: string) => {
    const copy = structuredClone(snapshot);
    writing = writing.then(() => input.checkpoint(copy, stage));
    return writing;
  };
  await save("frames");
  let failed = false; let failure: unknown;
  const pool = async (count: number, concurrency: number, work: (index: number) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (!failed && next < count) {
        const index = next++;
        try { input.signal?.throwIfAborted(); await work(index); }
        catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    }));
  };
  const text = new Map<string, FrameText>(snapshot.frameTexts.map(t => [t.frameId, t]));
  const batches = Array.from({ length: Math.ceil(input.selection.visual.length / ANALYSIS_LIMITS.batchImages) }, (_, index) =>
    input.selection.visual.slice(index * ANALYSIS_LIMITS.batchImages, (index + 1) * ANALYSIS_LIMITS.batchImages));
  // Keep completed visual evidence during resume. Batch indices and ordered
  // inputs stay identical, so the ledger reuses receipts without another call.
  const observations = batches.map(batch => snapshot.observations.filter(o => o.frameIds.every(id => batch.some(f => f.id === id))));
  await Promise.all([
    pool(input.selection.ocr.length, parallelism.ocrConcurrency, async index => {
      const frame = input.selection.ocr[index];
      if (text.has(frame.id)) return;
      try {
        const result = await input.models.ocr(frame, input.signal);
        text.set(frame.id, result);
        snapshot.frameTexts = snapshot.frames.flatMap(f => text.has(f.id) ? [text.get(f.id)!] : []);
        if (input.revision === 1) snapshot.texts = mergeScreenText(snapshot.frames, snapshot.frameTexts);
      } catch (error) {
        if (!(error instanceof AnalysisError) || !["MODEL_INVALID_JSON", "MODEL_INVALID_EVIDENCE", "MODEL_STEP_FAILED"].includes(error.code)) throw error;
        // Known malformed output is not retried. Synthesis sees the gap.
        snapshot.coverage!.omittedOcrFrameIds = [...new Set([...snapshot.coverage!.omittedOcrFrameIds, frame.id])].sort();
        snapshot.coverage!.limitations = [...new Set([...snapshot.coverage!.limitations, "OCR_INCOMPLETE"])];
      }
      await save("ocr");
    }),
    pool(batches.length, parallelism.visualConcurrency, async index => {
      observations[index] = await input.models.observe(index, batches[index], input.signal);
      snapshot.observations = observations.flat();
      snapshot.completedVisualBatches = [...new Set([...(snapshot.completedVisualBatches ?? []), index])].sort((a, b) => a - b);
      await save("visual");
    }),
  ]);
  // Drain in-flight receipts/checkpoints after a fatal error, then stop. Never
  // start a summary on partial inputs or silently retry a paid request.
  if (failed) throw failure;
  // The final text-only call sees only evidence actually sent to a model.
  input.signal?.throwIfAborted();
  let summary;
  if (input.prepareSummary) summary = await input.prepareSummary(snapshot);
  else { updateAnalysisCoverage(snapshot, input.selection); summary = summaryInput(snapshot, input.revision); }
  snapshot.summary = await input.models.summarize(summary, input.signal);
  snapshot.summaryRevision = input.revision;
  await save("summary");
  return snapshot;
}
