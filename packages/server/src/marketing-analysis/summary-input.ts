import { ANALYSIS_LIMITS, type AnalysisSnapshot } from "@lot-agent/core/marketing-analysis";

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
