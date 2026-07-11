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
  video: { durationSec: "number", ratio: "string" },
};

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
