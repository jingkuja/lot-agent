import { TokenhubClientError, type ModelEstimate, type ModelEstimateRequest, type TokenhubClient } from "../tokenhub/client.js";
import { estimateSeedanceVideoTokens, estimateVideoTokenPoints, isSeedanceTokenModel } from "./video-points-estimate.js";

export async function predictModelCost(
  tokenhub: Pick<TokenhubClient, "listModels" | "estimateModelCost">, apiKey: string, usage: ModelEstimateRequest, signal?: AbortSignal,
): Promise<Omit<ModelEstimate, "estimatedQuota"> & { estimatedQuota: number | null }> {
  const { model, video, image } = usage;
  if (video != null && (await tokenhub.listModels(apiKey, signal)).video_token_models?.includes(model)) {
    const totalTokens = video.total_tokens ?? (isSeedanceTokenModel(model) ? estimateSeedanceVideoTokens(usage) : undefined);
    if (image != null || totalTokens === null) throw new TokenhubClientError("Invalid video estimate usage", undefined, undefined, 400);
    if (totalTokens !== undefined) {
      return tokenhub.estimateModelCost(apiKey, { ...usage, video: { ...video, total_tokens: totalTokens } }, signal);
    }
    const estimatedPoints = estimateVideoTokenPoints(usage);
    if (estimatedPoints == null) throw new TokenhubClientError("Invalid video estimate usage", undefined, undefined, 400);
    return { model, pricingScheme: "video_token", estimatedPoints, estimatedQuota: null };
  }
  return tokenhub.estimateModelCost(apiKey, usage, signal);
}
