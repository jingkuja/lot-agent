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
  /** Reference images per request without a reference video: the total and each studio
   * section (background and scene share `setting`). Section caps may add up to more than
   * the total; the total still applies. */
  referenceImages: { total: number; portrait: number; product: number; setting: number };
  /** Reference images allowed with a reference video; 0 means the model ignores them. */
  imagesWithReferenceVideo: number;
  /** How a clip prompt names the submitted image at `index` (0-based submission order):
   * `${prefix}${index + firstNumber}${suffix}`. */
  imagePromptTag: { prefix: string; suffix: string; firstNumber: 0 | 1 };
  /** Highest quality when any image or video reference is submitted. */
  referenceMaxQuality?: "720p";
  /** Documented reference video limits; omitted when the vendor publishes none. */
  referenceVideo?: {
    minSeconds: number; maxSeconds: number; minFps: number; maxFps: number;
    minEdge: number; maxEdge: number; maxPixels: number; minAspect: number; maxAspect: number;
  };
  /** Prompt length cap for one clip request. */
  promptMaxChars: number;
  /** Reference image contract, checked on upload and again by the server before submission. */
  referenceImage: {
    formats: readonly ("image/jpeg" | "image/png" | "image/webp")[];
    maxBytes: number;
    /** Omitted when the vendor publishes no dimension limits. */
    minEdge?: number; minAspect?: number; maxAspect?: number;
  };
}

// https://cloud.tencent.com/document/product/1823/135742
// Reference images and elements: at most 7 without a reference video, 4 with one.
export const KLING_MARKETING_PROFILE: MarketingVideoProfile = {
  modelId: "kling-video-v3-omni",
  shotMaxSeconds: 15,
  referenceVideoShotMaxSeconds: 15,
  referenceImages: { total: 7, portrait: 3, product: 3, setting: 3 },
  imagesWithReferenceVideo: 3,
  imagePromptTag: { prefix: "image ", suffix: "", firstNumber: 1 },
  referenceVideo: { minSeconds: 3, maxSeconds: 15.5, minFps: 24, maxFps: 60, minEdge: 700, maxEdge: 4553, maxPixels: 8_294_400, minAspect: 0.4, maxAspect: 2 },
  promptMaxChars: 3072,
  referenceImage: { formats: ["image/jpeg", "image/png"], maxBytes: 50 * 1024 * 1024, minEdge: 300, minAspect: 1 / 2.5, maxAspect: 2.5 },
};

// https://docs.x.ai/developers/model-capabilities/video/generation
// A reference video replaces image and voice references and fails over 8
// seconds upstream. No prompt limit is documented; a 5000-character prompt through the
// gateway was accepted on 2026-10-28 and its last line was still followed in the clip.
// https://docs.x.ai/developers/model-capabilities/video/reference-to-video
// Up to 14 reference images, named in the prompt by position from <IMAGE_0>. Only
// the count is documented, so the contract is a decodable JPG/PNG/WebP within the
// marketing upload size.
export const GROK_MARKETING_PROFILE: MarketingVideoProfile = {
  modelId: "grok-imagine-video-1.5",
  shotMaxSeconds: 15,
  referenceVideoShotMaxSeconds: 8,
  referenceImages: { total: 14, portrait: 4, product: 5, setting: 5 },
  imagesWithReferenceVideo: 0,
  imagePromptTag: { prefix: "<IMAGE_", suffix: ">", firstNumber: 0 },
  referenceMaxQuality: "720p",
  promptMaxChars: 5000,
  referenceImage: { formats: ["image/jpeg", "image/png", "image/webp"], maxBytes: 20 * 1024 * 1024 },
};

export const MARKETING_VIDEO_PROFILES: readonly MarketingVideoProfile[] = [KLING_MARKETING_PROFILE, GROK_MARKETING_PROFILE];
export const DEFAULT_MARKETING_VIDEO_MODEL = GROK_MARKETING_PROFILE.modelId;
/** Largest image section of any profile; drafts store at most this many per slot. */
export const MARKETING_MAX_SECTION_IMAGES = Math.max(...MARKETING_VIDEO_PROFILES.flatMap(profile => [profile.referenceImages.portrait, profile.referenceImages.product, profile.referenceImages.setting]));

export function marketingVideoProfile(modelId: string | null | undefined): MarketingVideoProfile | undefined {
  return MARKETING_VIDEO_PROFILES.find(profile => profile.modelId === modelId);
}

export const DEFAULT_MARKETING_VIDEO_PROFILE = marketingVideoProfile(DEFAULT_MARKETING_VIDEO_MODEL)!;

const IMAGE_FORMAT_NAMES = { "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WebP" } as const;
/** `mime` must come from the file signature on the server; width/height 0 means unreadable. */
export function marketingReferenceImageIssue(profile: MarketingVideoProfile, image: { mime: string; size: number; width: number; height: number }): string | undefined {
  const rules = profile.referenceImage;
  if (!rules.formats.includes(image.mime as never)) return `当前视频模型的参考图仅支持 ${rules.formats.map(format => IMAGE_FORMAT_NAMES[format]).join("、")} 格式`;
  if (!image.size || image.size > rules.maxBytes) return `参考图大小不能超过 ${Math.round(rules.maxBytes / 1024 / 1024)}MB`;
  if (!image.width || !image.height) return "无法读取图片尺寸，请更换图片";
  // Both bounds are symmetric, so EXIF rotation cannot change the result.
  if (rules.minEdge && Math.min(image.width, image.height) < rules.minEdge) return `参考图宽高不能小于 ${rules.minEdge}px`;
  const ratio = image.width / image.height;
  if ((rules.minAspect && ratio < rules.minAspect) || (rules.maxAspect && ratio > rules.maxAspect)) return `参考图宽高比需在 1:${1 / (rules.minAspect ?? 1)}–${rules.maxAspect ?? 1}:1 之间`;
  return undefined;
}
