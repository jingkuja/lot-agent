import {
  COMIC_VIDEO_RESOLUTION, type ComicFrozenGenerationInput, type ComicVideoCreditCheck,
} from "@lot-agent/core/comic-drama";
import { predictModelCost } from "../billing/model-estimate.js";
import type { StoredUser } from "../db/database.js";
import type { ModelEstimateRequest, TokenhubClient } from "../tokenhub/client.js";

export function comicVideoEstimateUsage(input: ComicFrozenGenerationInput): ModelEstimateRequest {
  return {
    model: input.modelId,
    video: {
      resolution: COMIC_VIDEO_RESOLUTION, seconds: input.durationMs / 1000, has_video_input: false,
      input_image_count: input.references.length + Number(!!input.firstFrame),
    },
    request_parameters: { resolution: COMIC_VIDEO_RESOLUTION, generate_audio: false, ratio: input.aspectRatio },
  };
}

type CreditDb = {
  getUserById(owner: string): Promise<Pick<StoredUser, "api_key" | "managed_api_key" | "external_user_id"> | null>;
};
type CreditGateway = Pick<TokenhubClient, "listModels" | "estimateModelCost"> & {
  getManagedBalance(userId: number, signal: AbortSignal): Promise<{ remainAmount: number; allowBalanceFallback: boolean }>;
};

export function createComicVideoCreditCheck(db: CreditDb, tokenhub: CreditGateway, managed: boolean) {
  return async (owner: string, input: ComicFrozenGenerationInput, signal: AbortSignal): Promise<ComicVideoCreditCheck | null> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    try {
      const user = await db.getUserById(owner);
      const managedKey = user?.managed_api_key;
      const key = managedKey ?? (managed ? null : user?.api_key);
      deadline.throwIfAborted();
      if (!key) return { reason: "unavailable" };
      // TokenHub performs the admission check before sending the request upstream.
      // Only a managed key without wallet fallback has a balance we can compare locally.
      if (!managedKey) return null;
      if (user?.external_user_id == null) return { reason: "unavailable" };
      const { remainAmount: amount, allowBalanceFallback } = await tokenhub.getManagedBalance(user.external_user_id, deadline);
      deadline.throwIfAborted();
      if (allowBalanceFallback === true) return null;
      if (allowBalanceFallback !== false || !Number.isFinite(amount)) return { reason: "unavailable" };
      const { estimatedPoints: requiredPoints } = await predictModelCost(tokenhub, key, comicVideoEstimateUsage(input), deadline);
      deadline.throwIfAborted();
      if (!Number.isFinite(requiredPoints) || requiredPoints < 0) return { reason: "unavailable" };
      // Shift the decimal without introducing a multiplication artifact at an equal balance (e.g. 0.29 yuan = 29 credits).
      const [mantissa, exponent = "0"] = String(amount).split("e");
      const availablePoints = Math.max(0, Number(`${mantissa}e${Number(exponent) + 2}`));
      if (!Number.isFinite(availablePoints)) return { reason: "unavailable" };
      return availablePoints < requiredPoints ? { reason: "insufficient", availablePoints, requiredPoints } : null;
    } catch {
      signal.throwIfAborted();
      return { reason: "unavailable" };
    }
  };
}
