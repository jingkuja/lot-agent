import {
  COMIC_IMAGE_SIZES, comicVideoProfile,
  type ComicDramaDetail, type ComicEpisodeBudget, type ComicEpisodeBudgetInput, type ComicEpisodeBudgetLine,
  type ComicGenerationMode, type ComicGenerationPreviewRequest, type ComicTakeInput,
} from "@lot-agent/core/comic-drama";
import type { ModelEstimateRequest } from "../tokenhub/client.js";
import { comicVideoEstimateUsage } from "./credit-check.js";

export type EpisodeBudgetPricing = {
  imageModel: string | null; textModel: string | null; speechModel: string | null;
  predict: (usage: ModelEstimateRequest, signal: AbortSignal) => Promise<{ estimatedPoints: number; pricingScheme: string }>;
};
type Plan = Omit<ComicEpisodeBudgetLine, "estimatedPoints"> & { usage?: ModelEstimateRequest; calls?: number };
type ResolveInputs = (body: ComicGenerationPreviewRequest, model: string) => Promise<{ inputs: ComicTakeInput[] }>;

export async function estimateComicEpisode(
  detail: ComicDramaDetail, budget: ComicEpisodeBudgetInput, pricing: EpisodeBudgetPricing, resolve: ResolveInputs, signal: AbortSignal,
): Promise<ComicEpisodeBudget> {
  const { series, clips } = detail;
  const { imageModel, textModel, speechModel } = pricing;
  const videoMode = budget.videoMode ?? "from_keyframe";
  const redo = new Set(budget.redoVideos);
  const pendingFrames = clips.filter(c => !c.progress?.keyframeApproved && (c.progress?.videoState !== "ready" || redo.has(c.id)));
  const pendingVideos = clips.filter(c => c.progress?.videoState !== "ready" || redo.has(c.id));
  const plans: Plan[] = [];

  async function addClips(kind: "keyframe" | "video", mode: ComicGenerationMode, selected: typeof clips, modelId: string | null, futureFrame = false) {
    if (!selected.length) return;
    const { inputs } = modelId ? await resolve({ expectedSeriesRevision: series.revision, mode, targets: selected.map(clip => ({
      clipId: clip.id, expectedRevision: clip.revision, replaceAdopted: redo.has(clip.id),
    })) }, modelId) : { inputs: [] };
    const resolved = new Map(inputs.flatMap(input => "clipId" in input ? [[input.clipId, input] as const] : []));
    for (const clip of selected) {
      const input = resolved.get(clip.id);
      let usage: ModelEstimateRequest | undefined;
      if (input && kind === "video") {
        const video = comicVideoEstimateUsage(input);
        const count = (video.video?.input_image_count ?? 0) + Number(futureFrame);
        if (count <= (comicVideoProfile(input.modelId)?.referenceImages.total ?? 0) && video.video) {
          usage = { ...video, video: { ...video.video, input_image_count: count } };
        }
      } else if (input) {
        usage = { model: input.modelId, image: { size: COMIC_IMAGE_SIZES[input.aspectRatio], count: 1, reference_count: input.references.length } };
      }
      plans.push({ kind, modelId, clipId: clip.id, quantity: kind === "video" ? clip.draft.durationMs / 1000 : 1, usage });
    }
  }

  if (videoMode === "from_keyframe") {
    await addClips("keyframe", "keyframe", pendingFrames, imageModel);
    await addClips("video", "from_keyframe", pendingVideos.filter(c => c.progress?.keyframeApproved), series.videoModel);
    await addClips("video", "references", pendingVideos.filter(c => !c.progress?.keyframeApproved), series.videoModel, true);
  } else await addClips("video", "references", pendingVideos, series.videoModel);
  for (const [kind, quantity, size] of [
    ["character", budget.characterImages ?? 0, COMIC_IMAGE_SIZES["1:1"]],
    ["material", budget.materialImages ?? 0, COMIC_IMAGE_SIZES[series.aspectRatio]],
  ] as const) {
    if (quantity) plans.push({ kind, modelId: imageModel, quantity, calls: quantity,
      usage: imageModel ? { model: imageModel, image: { size, count: 1, reference_count: 0 } } : undefined });
  }
  if (budget.text && budget.text.inputTokens + budget.text.outputTokens > 0) {
    const { inputTokens, outputTokens } = budget.text;
    plans.push({ kind: "text", modelId: textModel, quantity: 1, inputTokens, outputTokens,
      usage: textModel ? { model: textModel, input_tokens: inputTokens, output_tokens: outputTokens } : undefined });
  }
  if (budget.speechLines) plans.push({ kind: "speech", modelId: speechModel, quantity: budget.speechLines, calls: budget.speechLines,
    usage: speechModel ? { model: speechModel } : undefined });

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const work = new Map<string, ModelEstimateRequest>();
  for (const plan of plans) if (plan.usage) work.set(JSON.stringify(plan.usage), plan.usage);
  const jobs = [...work];
  const results = new Map<string, Awaited<ReturnType<EpisodeBudgetPricing["predict"]>>>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (!deadline.aborted && cursor < jobs.length) {
      const [key, usage] = jobs[cursor++];
      try { results.set(key, await pricing.predict(usage, deadline)); } catch { /* Leave the line unpriced. */ }
    }
  }));
  signal.throwIfAborted();
  const items = plans.map(({ usage, calls = 1, ...line }): ComicEpisodeBudgetLine => {
    const result = usage ? results.get(JSON.stringify(usage)) : undefined;
    const points = result?.estimatedPoints;
    const verified = points != null && Number.isFinite(points) && points >= 0 && (line.kind !== "speech" || result?.pricingScheme === "per_call");
    return { ...line, estimatedPoints: verified ? points * calls : null };
  });
  const { knownPoints, unverifiedCount } = items.reduce((total, item) => ({
    knownPoints: total.knownPoints + (item.estimatedPoints ?? 0), unverifiedCount: total.unverifiedCount + Number(item.estimatedPoints === null),
  }), { knownPoints: 0, unverifiedCount: 0 });
  const totals = { revision: series.revision, items, knownPoints, unverifiedCount };
  if (!detail.summary?.costs) return totals;
  const { remainingEstimate: _legacy, ...costs } = detail.summary.costs;
  return { ...totals, costs };
}
