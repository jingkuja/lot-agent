import { ANALYSIS_LIMITS, type AnalysisCoverage, type FrameEvidence } from "./index.js";

/** Max tile difference catches local subtitle/price changes hidden by a
 * nearly static full-frame average. Gray images are fixed at 96 × 54. */
export function grayDifference(a: Uint8Array, b: Uint8Array): { global: number; local: number } {
  if (a.length !== 96 * 54 || b.length !== a.length) throw new Error("INVALID_GRAY_FRAME");
  const tiles = new Array<number>(18).fill(0);
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i] - b[i]) / 255;
    total += diff; tiles[Math.floor(i / 96 / 18) * 6 + Math.floor((i % 96) / 16)] += diff;
  }
  return { global: total / a.length, local: Math.max(...tiles) / (16 * 18) };
}

/** Deterministic whole-clip coverage when a hard image budget is reached. */
function budgeted(frames: FrameEvidence[], cap: number): FrameEvidence[] {
  if (frames.length <= cap) return frames;
  const indices = new Set(Array.from({ length: cap }, (_, i) => Math.round(i * (frames.length - 1) / (cap - 1))));
  return frames.filter((_, i) => indices.has(i));
}

export function selectAnalysisFrames(frames: FrameEvidence[], gray: Uint8Array[]) {
  if (frames.length !== gray.length || !frames.length || frames.length > ANALYSIS_LIMITS.candidates) throw new Error("INVALID_CANDIDATE_FRAMES");
  if (frames.some((f, i) => i && f.ptsMs <= frames[i - 1].ptsMs)) throw new Error("INVALID_FRAME_ORDER");
  const reasons = frames.map(() => new Set<FrameEvidence["reasons"][number]>());
  reasons[0].add("start"); reasons.at(-1)!.add("end");
  let periodicMs = 0;
  for (let i = 1; i < frames.length; i++) {
    const delta = grayDifference(gray[i - 1], gray[i]);
    if (delta.local >= 0.025) { reasons[i].add("change"); reasons[i - 1].add("before_change"); }
    if (delta.global >= 0.15) reasons[i].add("scene");
    if (frames[i].ptsMs - periodicMs >= 5000) { reasons[i].add("periodic"); periodicMs = frames[i].ptsMs; }
  }
  const annotated = frames.map((f, i) => ({ ...f, reasons: [...reasons[i]] }));
  const candidates = annotated.filter(f => f.reasons.length);
  const ocr = budgeted(candidates, ANALYSIS_LIMITS.ocrImages);
  const visualCandidates = annotated.filter(f => f.reasons.some(r => ["start", "end", "periodic", "scene"].includes(r)));
  const visual = budgeted(visualCandidates, ANALYSIS_LIMITS.visualImages);
  const coverage: AnalysisCoverage = {
    sampledFrames: frames.length, ocrFrames: ocr.length, visualFrames: visual.length,
    omittedOcrFrameIds: candidates.filter(f => !ocr.some(v => v.id === f.id)).map(f => f.id),
    omittedVisualFrameIds: visualCandidates.filter(f => !visual.some(v => v.id === f.id)).map(f => f.id),
    limitations: ["SAMPLED_IMAGES_ONLY", "NO_AUDIO_ANALYSIS", "BRIEF_TEXT_MAY_BE_MISSED"],
  };
  if (coverage.omittedOcrFrameIds.length) coverage.limitations.push("OCR_BUDGET_EXHAUSTED");
  if (coverage.omittedVisualFrameIds.length) coverage.limitations.push("VISUAL_BUDGET_EXHAUSTED");
  return { frames: annotated, ocr, visual, coverage };
}
