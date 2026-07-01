/** The task's selected model id (persisted in the job input by the enqueue site),
 * falling back to the media type's configured default. */
export function pickGenModel(
  _mediaType: "image" | "video",
  input: Record<string, unknown>,
  fallback: string
): string {
  const m = input.modelId;
  return typeof m === "string" && m.length > 0 ? m : fallback;
}
