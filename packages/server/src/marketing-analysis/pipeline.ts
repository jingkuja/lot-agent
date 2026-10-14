import { ANALYSIS_LIMITS, mergeScreenText, type AnalysisSnapshot, type FrameEvidence, type FrameText } from "@lot-agent/core/marketing-analysis";
import type { AnalysisModels } from "./models.js";
import type { extractAnalysisFrames } from "./frames.js";

/** Reusable local/model stages. The production job layer must supply durable
 * checkpoints and a ledger; this deliberately does not create an HTTP task or
 * silently run a downloader outside its isolated environment. */
export async function analyzeSelectedFrames(input: {
  snapshot: AnalysisSnapshot;
  selection: Awaited<ReturnType<typeof extractAnalysisFrames>>;
  revision: number;
  models: AnalysisModels;
  checkpoint(snapshot: AnalysisSnapshot, stage: string): Promise<void>;
  signal?: AbortSignal;
}) {
  const snapshot: AnalysisSnapshot = structuredClone(input.snapshot);
  snapshot.frames = input.selection.frames; snapshot.coverage = input.selection.coverage;
  snapshot.source.durationMs = input.selection.durationMs;
  let writing = Promise.resolve();
  const save = (stage: string) => {
    const copy = structuredClone(snapshot);
    writing = writing.then(() => input.checkpoint(copy, stage));
    return writing;
  };
  await save("frames");
  let next = 0; let failure: unknown;
  const text = new Map<string, FrameText>(snapshot.frameTexts.map(t => [t.frameId, t]));
  const work = async () => {
    while (!failure && next < input.selection.ocr.length) {
      const frame = input.selection.ocr[next++];
      if (text.has(frame.id)) continue;
      try {
        input.signal?.throwIfAborted();
        const result = await input.models.ocr(frame, input.signal);
        text.set(frame.id, result);
        snapshot.frameTexts = snapshot.frames.flatMap(f => text.has(f.id) ? [text.get(f.id)!] : []);
        if (input.revision === 1) snapshot.texts = mergeScreenText(snapshot.frames, snapshot.frameTexts);
        await save("ocr");
      } catch (error) { failure ??= error; }
    }
  };
  await Promise.all([work(), work()]);
  if (failure) throw failure;
  snapshot.observations = [];
  for (let offset = 0; offset < input.selection.visual.length; offset += ANALYSIS_LIMITS.batchImages) {
    input.signal?.throwIfAborted();
    const batch = input.selection.visual.slice(offset, offset + ANALYSIS_LIMITS.batchImages);
    snapshot.observations.push(...await input.models.observe(offset / ANALYSIS_LIMITS.batchImages, batch, input.signal));
    await save("visual");
  }
  // The final text-only call sees only evidence actually sent to a model.
  const evidence = new Set([...snapshot.frameTexts.map(t => t.frameId), ...snapshot.observations.flatMap(o => o.frameIds)]);
  const frames: FrameEvidence[] = snapshot.frames.filter(f => evidence.has(f.id));
  input.signal?.throwIfAborted();
  snapshot.summary = await input.models.summarize({ revision: input.revision, frames, texts: snapshot.texts, observations: snapshot.observations,
    durationMs: input.selection.durationMs, metadata: { title: snapshot.source.title, author: snapshot.source.author }, limitations: snapshot.coverage.limitations }, input.signal);
  snapshot.summaryRevision = input.revision;
  await save("summary");
  return snapshot;
}
