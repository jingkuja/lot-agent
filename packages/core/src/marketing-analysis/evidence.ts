import { AnalysisSummarySchema, ObservationSchema, type AnalysisSummary, type FrameEvidence, type FrameText, type ScreenText, type VisualObservation } from "./index.js";

/** Merge adjacent observed frames only. Missing OCR, empty frames and any
 * changed character break a run; identical text later in the clip is retained. */
export function mergeScreenText(frames: FrameEvidence[], observations: FrameText[]): ScreenText[] {
  const byId = new Map(observations.map(o => [o.frameId, o.rawText]));
  if (byId.size !== observations.length || observations.some(o => !frames.some(f => f.id === o.frameId))) throw new Error("INVALID_OCR_REFERENCE");
  const result: ScreenText[] = [];
  let previous: ScreenText | undefined;
  for (const frame of [...frames].sort((a, b) => a.ptsMs - b.ptsMs)) {
    const rawText = byId.get(frame.id)?.trim();
    if (!rawText) { previous = undefined; continue; }
    if (previous && previous.rawText === rawText && frame.ptsMs - previous.lastSeenMs <= 750) {
      previous.lastSeenMs = frame.ptsMs; previous.frameIds.push(frame.id);
    } else {
      previous = { id: `t${String(result.length + 1).padStart(4, "0")}`, rawText, text: rawText, frameIds: [frame.id], firstSeenMs: frame.ptsMs, lastSeenMs: frame.ptsMs };
      result.push(previous);
    }
  }
  return result;
}

export function validateObservation(value: unknown, frames: FrameEvidence[]): VisualObservation {
  const result = ObservationSchema.parse(value);
  if (new Set(result.frameIds).size !== result.frameIds.length || result.frameIds.some(id => !frames.some(f => f.id === id))) throw new Error("INVALID_FRAME_REFERENCE");
  const positions = result.frameIds.map(id => frames.findIndex(f => f.id === id));
  if (positions.some((p, i) => i > 0 && p < positions[i - 1])) throw new Error("INVALID_FRAME_ORDER");
  return result;
}

export function validateSummary(value: unknown, frames: FrameEvidence[], texts: ScreenText[], durationMs: number): AnalysisSummary {
  const result = AnalysisSummarySchema.parse(value);
  const times = new Map<string, [number, number]>(frames.map(f => [f.id, [f.ptsMs, f.ptsMs]]));
  for (const text of texts) times.set(text.id, [text.firstSeenMs, text.lastSeenMs]);
  for (const item of [...result.summary, ...result.timeline, ...result.marketingPoints]) {
    if (new Set(item.evidenceIds).size !== item.evidenceIds.length || item.evidenceIds.some(id => !times.has(id))) throw new Error("INVALID_EVIDENCE_REFERENCE");
  }
  let prior = -1;
  for (const item of result.timeline) {
    if (item.startMs < prior || item.endMs > durationMs) throw new Error("INVALID_TIMELINE_RANGE");
    if (item.evidenceIds.some(id => { const [start, end] = times.get(id)!; return end < item.startMs || start > item.endMs; })) throw new Error("EVIDENCE_OUTSIDE_TIMELINE");
    const cited = item.evidenceIds.map(id => times.get(id)!);
    // A single sampled image must not become a long continuous scene.
    // Permit at most one 2Hz sampling interval of endpoint rounding.
    if (item.startMs < Math.min(...cited.map(t => t[0])) - 500 || item.endMs > Math.max(...cited.map(t => t[1])) + 500) throw new Error("EVIDENCE_OUTSIDE_TIMELINE");
    prior = item.startMs;
  }
  return result;
}
