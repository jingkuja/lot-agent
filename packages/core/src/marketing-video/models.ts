/**
 * Video models the marketing studio can submit clips to. Every clip goes
 * through the shared `/videos` request; a profile only describes the model's
 * limits so drafts, storyboards and recovery stay model-agnostic.
 *
 * To switch models, set `MARKETING_VIDEO_MODEL` on the server to another
 * profile id. Frozen jobs keep the profile of the `modelId` they recorded, so
 * never remove a profile that existing jobs may still reference.
 */
export interface MarketingVideoProfile {
  /** Vendor model id sent in the generation request. */
  modelId: string;
  /** Longest shot without a generation reference video. */
  shotMaxSeconds: number;
  /** Longest shot when a generation reference video is selected. */
  referenceVideoShotMaxSeconds: number;
  /** Portrait/background/scene images allowed with a reference video; 0 means the model ignores them. */
  imagesWithReferenceVideo: number;
  /** Highest quality when any image or video reference is submitted. */
  referenceMaxQuality?: "720p";
  /** Documented reference video limits; omitted when the vendor publishes none. */
  referenceVideo?: {
    minSeconds: number; maxSeconds: number; minFps: number; maxFps: number;
    minEdge: number; maxEdge: number; maxPixels: number; minAspect: number; maxAspect: number;
  };
  /** Prompt length cap for one clip request. */
  promptMaxChars: number;
}

// https://cloud.tencent.com/document/product/1823/135742
export const KLING_MARKETING_PROFILE: MarketingVideoProfile = {
  modelId: "kling-video-v3-omni",
  shotMaxSeconds: 15,
  referenceVideoShotMaxSeconds: 15,
  imagesWithReferenceVideo: 3,
  referenceVideo: { minSeconds: 3, maxSeconds: 15.5, minFps: 24, maxFps: 60, minEdge: 700, maxEdge: 4553, maxPixels: 8_294_400, minAspect: 0.4, maxAspect: 2 },
  promptMaxChars: 3072,
};

// https://docs.x.ai/developers/model-capabilities/video/generation
// A reference video replaces image and voice references and fails over 8
// seconds upstream. No prompt limit is documented, so Kling's cap is kept.
export const GROK_MARKETING_PROFILE: MarketingVideoProfile = {
  modelId: "grok-imagine-video-1.5",
  shotMaxSeconds: 15,
  referenceVideoShotMaxSeconds: 8,
  imagesWithReferenceVideo: 0,
  referenceMaxQuality: "720p",
  promptMaxChars: 3072,
};

export const MARKETING_VIDEO_PROFILES: readonly MarketingVideoProfile[] = [KLING_MARKETING_PROFILE, GROK_MARKETING_PROFILE];
export const DEFAULT_MARKETING_VIDEO_MODEL = GROK_MARKETING_PROFILE.modelId;

export function marketingVideoProfile(modelId: string | null | undefined): MarketingVideoProfile | undefined {
  return MARKETING_VIDEO_PROFILES.find(profile => profile.modelId === modelId);
}

export const DEFAULT_MARKETING_VIDEO_PROFILE = marketingVideoProfile(DEFAULT_MARKETING_VIDEO_MODEL)!;
