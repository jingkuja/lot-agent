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
const SETTING_TYPES: Record<"image" | "video", Record<string, "string" | "number">> = {
  image: { size: "string", n: "number" },
  // `size` (WxH) is required by the openai-video `/videos` endpoint; `ratio` is
  // kept for metadata/back-compat though the openai-video adapter no longer sends it.
  video: { size: "string", durationSec: "number", ratio: "string" },
};

export const VIDEO_REFERENCE_LIMITS = {
  input_reference: 5,
  reference_video: 2,
  reference_audio: 2,
} as const;

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

export function pickGenerationSettings(
  mediaType: "image" | "video",
  raw: Record<string, unknown> | undefined
): Record<string, string | number> {
  const allowed = SETTING_TYPES[mediaType];
  const out: Record<string, string | number> = {};
  if (!raw) return out;
  for (const [key, type] of Object.entries(allowed)) {
    const value = raw[key];
    if (typeof value === type) out[key] = value as string | number;
  }
  return out;
}
