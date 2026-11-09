import { grokVideoInputIssue, isGrokVideoModel } from "@lot-agent/core";

/**
 * Per-media whitelist for client-supplied generation settings.
 *
 * Generation job inputs mix user business parameters with server identity
 * fields (userId / conversationId / assistantMessageId / taskId). The identity
 * fields decide WHICH rows a worker may write, so they must only ever come
 * from the server. This picker is the trust boundary: anything not explicitly
 * whitelisted here (wrong key, wrong media type, wrong runtime type) is
 * silently dropped before the input reaches the queue.
 */
type GenerationSettingValue = string | number | boolean;

const SETTING_TYPES: Record<"image" | "video", Record<string, "string" | "number" | "boolean">> = {
  // Image clients send a tier (1K/2K/4K) and a ratio; the server derives `size`.
  // A bare `size` stays accepted for older clients and stored settings.
  image: { resolution: "string", ratio: "string", size: "string", n: "number", quality: "string" },
  // TokenHub billing needs an explicit resolution tier or size (WxH).
  // Keep ratio independent so square/portrait videos retain the selected tier.
  video: { resolution: "string", size: "string", durationSec: "number", ratio: "string", quality: "string", generate_audio: "boolean" },
};

export const IMAGE_PRESET_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITY_VALUES = ["auto", "low", "medium", "high"] as const;
export const DEFAULT_IMAGE_QUALITY = "auto";
export const IMAGE_MIN_PIXELS = 655_360;
export const IMAGE_MAX_PIXELS = 8_294_400;
export const IMAGE_MAX_EDGE = 3840;
export const IMAGE_MAX_COUNT = 4;

/** Pixel budget per tier. 4K is the vendor maximum (3840×2160 = 2880×2880). */
export const IMAGE_RESOLUTION_PIXELS = { "1K": 1024 * 1024, "2K": 2048 * 2048, "4K": IMAGE_MAX_PIXELS } as const;
export type ImageResolution = keyof typeof IMAGE_RESOLUTION_PIXELS;
export const IMAGE_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

const roundTo16 = (value: number) => Math.max(16, Math.round(value / 16) * 16);

/**
 * Standard pixel size for a tier and ratio: the tier's pixel budget at that
 * ratio, both edges on the vendor's 16 px grid and within its edge / pixel
 * limits. gpt-image 1.5 only takes its three fixed sizes, so it gets the
 * matching orientation instead. Returns null for an unknown tier or ratio.
 */
export function imageSizeForTier(resolution: string, ratio: string, modelId?: string): string | null {
  const tier = resolution.trim().toUpperCase();
  if (!(tier in IMAGE_RESOLUTION_PIXELS) || !(IMAGE_RATIOS as readonly string[]).includes(ratio)) return null;
  const [rw, rh] = ratio.split(":").map(Number);
  if (isGptImage15(modelId)) return rw === rh ? "1024x1024" : rw > rh ? "1536x1024" : "1024x1536";
  const budget = IMAGE_RESOLUTION_PIXELS[tier as ImageResolution];
  let scale = Math.min(Math.sqrt(budget / (rw * rh)), IMAGE_MAX_EDGE / Math.max(rw, rh));
  for (;;) {
    const width = Math.min(roundTo16(rw * scale), IMAGE_MAX_EDGE);
    const height = Math.min(roundTo16(rh * scale), IMAGE_MAX_EDGE);
    if (width * height <= IMAGE_MAX_PIXELS) return `${width}x${height}`;
    scale *= 0.99;
  }
}

/** gpt-image 1.5 only accepts the three standard sizes; custom WxH is rejected. */
export function isGptImage15(modelId?: string): boolean {
  return /gpt[-_ ]?image[-_ ]?1[\.\-_]?5(?!\d)/i.test(modelId ?? "");
}

/** Validate a client-supplied image size/quality. Returns a page-facing error
 * or null when the request may be enqueued. Missing size is allowed (provider
 * default); missing quality is filled with `auto` by the caller. */
export function validateImageGenerationSettings(
  settings: Record<string, GenerationSettingValue>,
  modelId?: string
): string | null {
  if (typeof settings.quality === "string" && !(IMAGE_QUALITY_VALUES as readonly string[]).includes(settings.quality)) {
    return "质量仅支持 auto、low、medium、high";
  }
  if (settings.n !== undefined && (!Number.isInteger(settings.n) || Number(settings.n) < 1 || Number(settings.n) > IMAGE_MAX_COUNT)) {
    return `图片张数仅支持 1–${IMAGE_MAX_COUNT} 张`;
  }
  if (typeof settings.size !== "string") return null;
  const matched = /^(\d+)x(\d+)$/.exec(settings.size);
  if (!matched) return "请输入有效的分辨率";
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return "请输入有效的分辨率";
  }
  const widthInvalid = width % 16 !== 0;
  const heightInvalid = height % 16 !== 0;
  if (widthInvalid && heightInvalid) return "宽和高都必须能被 16 整除";
  if (widthInvalid) return "宽度必须能被 16 整除";
  if (heightInvalid) return "高度必须能被 16 整除";
  if (width > IMAGE_MAX_EDGE || height > IMAGE_MAX_EDGE) {
    return `边长不能超过 ${IMAGE_MAX_EDGE}`;
  }
  const pixels = width * height;
  if (pixels < IMAGE_MIN_PIXELS) return `分辨率过低，宽×高不能小于 ${IMAGE_MIN_PIXELS} 像素`;
  if (pixels > IMAGE_MAX_PIXELS) return `分辨率过高，宽×高不能大于 ${IMAGE_MAX_PIXELS} 像素`;
  if (width * 3 < height || height * 3 < width) return "宽高比不能超过 1:3 或 3:1";
  const size = `${width}x${height}`;
  if (isGptImage15(modelId) && !(IMAGE_PRESET_SIZES as readonly string[]).includes(size)) {
    return "当前模型不支持自定义分辨率";
  }
  return null;
}

export const VIDEO_REFERENCE_LIMITS = {
  input_reference: 9,
  reference_video: 3,
  reference_audio: 3,
} as const;

/** A reference audio input requires the generated video to contain audio. */
export function resolveVideoGenerateAudio(requested: unknown, referenceAudio: unknown): boolean {
  const hasReferenceAudio = Array.isArray(referenceAudio)
    ? referenceAudio.length > 0
    : typeof referenceAudio === "string" && referenceAudio.trim().length > 0;
  return hasReferenceAudio || requested === true;
}

type VideoReferenceField = keyof typeof VIDEO_REFERENCE_LIMITS;

/**
 * Pick the video reference fields from an untrusted request and enforce the
 * product limits at the server boundary. A scalar stays scalar for API
 * compatibility; an input array stays an array.
 */
export function pickVideoReferenceInputs(
  raw: Record<string, unknown> | undefined
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!raw) return out;

  for (const field of Object.keys(VIDEO_REFERENCE_LIMITS) as VideoReferenceField[]) {
    const value = raw[field];
    if (value == null) continue;
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((v) => typeof v === "string" && v.trim().length > 0)) {
      throw new Error(`${field} must contain non-empty URL strings`);
    }
    const limit = VIDEO_REFERENCE_LIMITS[field];
    if (values.length > limit) {
      throw new Error(`${field} supports at most ${limit} references`);
    }
    out[field] = Array.isArray(value) ? values as string[] : values[0] as string;
  }

  for (const field of ["first_frame", "last_frame"] as const) {
    const value = raw[field];
    if (value == null) continue;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field} must be a non-empty URL string`);
    }
    out[field] = value;
  }
  return out;
}

/** Grok model limits, checked on the whitelisted input including legacy `media` references. */
export function grokVideoIssue(modelId: string | undefined, input: Record<string, unknown>): string | undefined {
  if (!isGrokVideoModel(modelId)) return undefined;
  const count = (value: unknown) => Array.isArray(value) ? value.length : typeof value === "string" && value.trim() ? 1 : 0;
  const media = Array.isArray(input.media) ? input.media as { type?: unknown }[] : [];
  const legacy = (type: string) => media.filter((item) => item?.type === type).length;
  return grokVideoInputIssue({
    images: count(input.input_reference) + legacy("reference_image"),
    videos: count(input.reference_video) + legacy("reference_video"),
    audios: count(input.reference_audio) + legacy("reference_audio"),
    firstFrame: !!input.first_frame,
    lastFrame: !!input.last_frame,
    resolutions: [input.resolution, input.quality, input.size].map((value) => typeof value === "string" ? value : undefined),
    durationSec: typeof input.durationSec === "number" ? input.durationSec : undefined,
  });
}

/** Video quota/metering needs a positive second count. Seedance reference-video
 * jobs send durationSec = -1 (auto-adapt); bill those at the default 5s. */
export function billedVideoSeconds(durationSec: unknown): number {
  const n = Number(durationSec ?? 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export function pickGenerationSettings(
  mediaType: "image" | "video",
  raw: Record<string, unknown> | undefined
): Record<string, GenerationSettingValue> {
  const allowed = SETTING_TYPES[mediaType];
  const out: Record<string, GenerationSettingValue> = {};
  if (!raw) return out;
  for (const [key, type] of Object.entries(allowed)) {
    const value = raw[key];
    if (typeof value === type) out[key] = value as GenerationSettingValue;
  }
  return out;
}

/** Default image quality to `auto`, derive `size` from a tier + ratio, then
 * validate size/count/quality for the model. */
export function finalizeImageSettings(
  settings: Record<string, GenerationSettingValue>,
  modelId?: string
): { settings: Record<string, GenerationSettingValue>; error: string | null } {
  const next = { ...settings };
  if (typeof next.quality !== "string") next.quality = DEFAULT_IMAGE_QUALITY;
  if (typeof next.resolution === "string" || typeof next.ratio === "string") {
    const resolution = typeof next.resolution === "string" ? next.resolution.trim().toUpperCase() : "";
    const ratio = typeof next.ratio === "string" ? next.ratio : "";
    const size = imageSizeForTier(resolution, ratio, modelId);
    if (!size) return { settings: next, error: "请选择有效的清晰度和图片比例" };
    Object.assign(next, { resolution, ratio, size });
  }
  return { settings: next, error: validateImageGenerationSettings(next, modelId) };
}
