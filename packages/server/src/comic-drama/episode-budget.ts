import {
  COMIC_IMAGE_SIZES, COMIC_SPEECH_ESTIMATE_POINTS,
  type ComicDramaDetail, type ComicEpisodeBudget, type ComicEpisodeBudgetInput, type ComicEpisodeBudgetLine,
  type ComicGenerationMode, type ComicGenerationPreviewRequest, type ComicTakeInput,
} from "@lot-agent/core/comic-drama";
import type { ModelEstimateRequest } from "../tokenhub/client.js";
import { comicVideoEstimateUsage } from "./credit-check.js";

export type EpisodeBudgetPricing = {
  imageModel: string | null; textModel: string | null; speechModel: string | null;
  videoModels?: readonly string[];
  predictionScope?: string;
  predict: (usage: ModelEstimateRequest, signal: AbortSignal) => Promise<{ estimatedPoints: number; pricingScheme: string }>;
};
type Plan = Omit<ComicEpisodeBudgetLine, "estimatedPoints"> & { usage?: ModelEstimateRequest; calls?: number; fixedPoints?: number };
type ResolveInputs = (body: ComicGenerationPreviewRequest, model: string, forecastFirstFrame: boolean) => Promise<{ inputs: ComicTakeInput[] }>;
const committed = new Set(["pending", "running", "recoverable", "unknown"]);

export function createComicBudgetPredictionCache() {
  type Prediction = Awaited<ReturnType<EpisodeBudgetPricing["predict"]>>;
  const recent = new Map<string, { expiresAt: number; result: Prediction }>();
  return (owner: string, seriesId: string, pricing: EpisodeBudgetPricing): EpisodeBudgetPricing => {
    if (!pricing.predictionScope) return pricing;
    return { ...pricing, predict: async (usage, signal) => {
      signal.throwIfAborted();
      const key = JSON.stringify([owner, seriesId, pricing.predictionScope, usage]);
      const cached = recent.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.result;
      recent.delete(key);
      const result = await pricing.predict(usage, signal);
      signal.throwIfAborted();
      if (Number.isFinite(result.estimatedPoints) && result.estimatedPoints >= 0) {
        const oldest = recent.keys().next().value;
        if (recent.size >= 512 && oldest !== undefined) recent.delete(oldest);
        recent.set(key, { expiresAt: Date.now() + 60_000, result });
      }
      return result;
    } };
  };
}

export async function estimateComicEpisode(
  detail: ComicDramaDetail, budget: ComicEpisodeBudgetInput, pricing: EpisodeBudgetPricing, resolve: ResolveInputs, signal: AbortSignal,
): Promise<ComicEpisodeBudget> {
  const { series, clips } = detail;
  const { imageModel, textModel, speechModel } = pricing;
  const videoModel = series.videoModel && (!pricing.videoModels || pricing.videoModels.includes(series.videoModel)) ? series.videoModel : null;
  const videoMode = budget.videoMode ?? "from_keyframe";
  const redo = new Set(budget.redoVideos);
  const pendingVideos = clips.filter(({ id, progress }) => !committed.has(progress?.latestVideoState ?? progress?.videoState ?? "none")
    && (progress?.videoState !== "ready" || redo.has(id)));
  const pendingFrames = pendingVideos.filter(c => !c.progress?.keyframeApproved && !c.progress?.keyframeCandidateAvailable
    && !committed.has(c.progress?.keyframeState ?? "none"));
  const plans: Plan[] = [];

  async function addClips(kind: "keyframe" | "video", mode: ComicGenerationMode, selected: typeof clips, modelId: string | null, futureFrame = false) {
    if (!selected.length) return;
    const { inputs } = modelId ? await resolve({ expectedSeriesRevision: series.revision, mode, targets: selected.map(clip => ({
      clipId: clip.id, expectedRevision: clip.revision, replaceAdopted: redo.has(clip.id),
    })) }, modelId, futureFrame) : { inputs: [] };
    const resolved = new Map(inputs.flatMap(input => "clipId" in input ? [[input.clipId, input] as const] : []));
    for (const clip of selected) {
      const input = resolved.get(clip.id);
      let usage: ModelEstimateRequest | undefined;
      if (input && kind === "video") {
        const count = input.references.length + Number(!!input.firstFrame || futureFrame) + Number(!!input.lastFrame);
        usage = comicVideoEstimateUsage(input, count);
      } else if (input) {
        usage = { model: input.modelId, image: { size: COMIC_IMAGE_SIZES[input.aspectRatio], count: 1, reference_count: input.references.length } };
      }
      plans.push({ kind, modelId, clipId: clip.id, quantity: kind === "video" ? (input?.durationMs ?? clip.draft.durationMs) / 1000 : 1, usage });
    }
  }

  if (videoMode === "from_keyframe") {
    await addClips("keyframe", "keyframe", pendingFrames, imageModel);
    await addClips("video", "from_keyframe", pendingVideos.filter(c => c.progress?.keyframeApproved), videoModel);
    await addClips("video", "from_keyframe", pendingVideos.filter(c => !c.progress?.keyframeApproved), videoModel, true);
  } else await addClips("video", videoMode, pendingVideos, videoModel);
  for (const [kind, quantity] of [
    ["character", budget.characterImages ?? 0], ["material", budget.materialImages ?? 0],
  ] as const) {
    if (quantity) plans.push({ kind, modelId: imageModel, quantity, calls: quantity,
      usage: imageModel ? { model: imageModel, image: { size: COMIC_IMAGE_SIZES["1:1"], count: 1, reference_count: 0 } } : undefined });
  }
  if (budget.text && budget.text.inputTokens + budget.text.outputTokens > 0) {
    const { inputTokens, outputTokens } = budget.text;
    plans.push({ kind: "text", modelId: textModel, quantity: 1, inputTokens, outputTokens,
      usage: textModel ? { model: textModel, input_tokens: inputTokens, output_tokens: outputTokens } : undefined });
  }
  if (budget.speechLines) plans.push({ kind: "speech", modelId: speechModel, quantity: budget.speechLines,
    fixedPoints: budget.speechLines * COMIC_SPEECH_ESTIMATE_POINTS });

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
  const items = plans.map(({ usage, calls = 1, fixedPoints, ...line }): ComicEpisodeBudgetLine => {
    const points = usage ? results.get(JSON.stringify(usage))?.estimatedPoints : undefined;
    const verified = points != null && Number.isFinite(points) && points >= 0;
    return { ...line, estimatedPoints: fixedPoints ?? (verified ? points * calls : null) };
  });
  const { knownPoints, unverifiedCount } = items.reduce((total, item) => ({
    knownPoints: total.knownPoints + (item.estimatedPoints ?? 0), unverifiedCount: total.unverifiedCount + Number(item.estimatedPoints === null),
  }), { knownPoints: 0, unverifiedCount: 0 });
  const totals = { revision: series.revision, items, knownPoints, unverifiedCount };
  if (!detail.summary?.costs) return totals;
  const { remainingEstimate: _legacy, ...costs } = detail.summary.costs;
  const byCurrency = new Map<"CNY" | "USD", number>();
  for (const item of [...costs.settled, ...costs.quotedUnbilled]) {
    byCurrency.set(item.currency, (byCurrency.get(item.currency) ?? 0) + item.amountMicros);
  }
  const estimatedMonetaryTotals = [...byCurrency].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amountMicros]) => ({ currency, amountMicros }));
  return { ...totals, costs, estimatedMonetaryTotals };
}
