import { ANALYSIS_LIMITS, type AnalysisSnapshot } from "@lot-agent/core/marketing-analysis";
import type { extractAnalysisFrames } from "./frames.js";

/** Reconstruct processing gaps from the immutable selection, never citations.
 * Called only before the first summary intent; saved inputs remain immutable. */
export function updateAnalysisCoverage(snapshot: AnalysisSnapshot, selection: Awaited<ReturnType<typeof extractAnalysisFrames>>) {
  const coverage = structuredClone(selection.coverage);
  const completedOcr = new Set(snapshot.frameTexts.map(frame => frame.frameId));
  const completedVisual = new Set(snapshot.completedVisualBatches ?? []);
  coverage.omittedOcrFrameIds = [...new Set([...coverage.omittedOcrFrameIds, ...selection.ocr.filter(f => !completedOcr.has(f.id)).map(f => f.id)])];
  coverage.omittedVisualFrameIds = [...new Set([...coverage.omittedVisualFrameIds, ...selection.visual.filter((_f, i) => !completedVisual.has(Math.floor(i / ANALYSIS_LIMITS.batchImages))).map(f => f.id)])];
  if (selection.ocr.some(f => !completedOcr.has(f.id))) coverage.limitations.push("OCR_INCOMPLETE");
  if (selection.visual.some((_f, i) => !completedVisual.has(Math.floor(i / ANALYSIS_LIMITS.batchImages)))) coverage.limitations.push("VISUAL_INCOMPLETE");
  if (snapshot.speech?.status === "completed" && snapshot.speech.text.trim()) coverage.limitations = coverage.limitations.filter(value => value !== "NO_AUDIO_ANALYSIS");
  coverage.limitations = [...new Set(coverage.limitations)];
  snapshot.coverage = coverage;
}

/** Preserve first-seen order for frames-v1 receipts. Coverage records processing
 * gaps; cited frame counts describe claims, not completed visual batches. */
export function summaryInput(snapshot: AnalysisSnapshot, revision: number) {
  const evidence = new Set([...snapshot.frameTexts.map(t => t.frameId), ...snapshot.observations.flatMap(o => o.frameIds)]);
  const limitations = [...new Set(snapshot.coverage?.limitations ?? [])];
  if (snapshot.completedVisualBatches && snapshot.completedVisualBatches.length < Math.ceil((snapshot.coverage?.visualFrames ?? 0) / ANALYSIS_LIMITS.batchImages)) limitations.push("VISUAL_INCOMPLETE");
  return {
    revision, ...(snapshot.speech?.status === "completed" ? { speech: snapshot.speech } : {}), frames: snapshot.frames.filter(f => evidence.has(f.id)), texts: snapshot.texts,
    observations: snapshot.observations, durationMs: snapshot.source.durationMs!,
    metadata: { title: snapshot.source.title, author: snapshot.source.author },
    limitations: [...new Set(limitations)],
  };
}

/** JSONB reorders object keys; restore the wire order used before persistence. */
export function restoreSummaryInput(input: ReturnType<typeof summaryInput>): ReturnType<typeof summaryInput> {
  return { revision: input.revision, ...(input.speech ? { speech: input.speech } : {}), frames: input.frames, texts: input.texts,
    observations: input.observations, durationMs: input.durationMs,
    metadata: { title: input.metadata.title, author: input.metadata.author }, limitations: input.limitations };
}
