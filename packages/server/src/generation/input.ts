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
  image: { size: "string", n: "number", quality: "string" },
  // `size` (WxH) is required by the openai-video `/videos` endpoint; `ratio` is
  // kept for metadata/back-compat though the openai-video adapter no longer sends it.
  video: { size: "string", durationSec: "number", ratio: "string", generate_audio: "boolean" },
};

export const IMAGE_PRESET_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITY_VALUES = ["auto", "low", "medium", "high"] as const;
export const DEFAULT_IMAGE_QUALITY = "auto";
export const IMAGE_MIN_PIXELS = 655_360;
export const IMAGE_MAX_PIXELS = 8_294_400;
export const IMAGE_MAX_EDGE = 3840;

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
  input_reference: 5,
  reference_video: 2,
  reference_audio: 2,
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

/** Default image quality to `auto` then validate size/quality for the model. */
export function finalizeImageSettings(
  settings: Record<string, GenerationSettingValue>,
  modelId?: string
): { settings: Record<string, GenerationSettingValue>; error: string | null } {
  const next = { ...settings };
  if (typeof next.quality !== "string") next.quality = DEFAULT_IMAGE_QUALITY;
  return { settings: next, error: validateImageGenerationSettings(next, modelId) };
}
