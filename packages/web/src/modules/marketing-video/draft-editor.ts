import { marketingDraftProfile, marketingShotMaxSeconds, timeMarketingStoryboard, type MarketingDraft, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";

/** The draft after one field changes. New copy drops the old shots. A new duration or adding or
 * removing the reference video re-times the shots; shots that no longer fit are kept as they were
 * (they came from a paid request) and the plan reports the conflict until the user resolves it.
 * A reference video change also records what the board was planned for. `configured`: the server's clip model;
 * the shots fit the model the changed draft is made with. */
export function withDraftField<K extends keyof MarketingDraft>(current: MarketingDraft, name: K, value: MarketingDraft[K],
  configured: MarketingVideoProfile): MarketingDraft {
  const next = { ...current, [name]: value };
  if (value === current[name]) return next;
  if (name === "script") next.storyboard = [];
  const videoChanged = name === "assets" && !!next.assets.video !== !!current.assets.video;
  // Older boards carry no record; they were planned before this change.
  if (videoChanged && next.storyboard.length) next.storyboardAudio ??= !current.assets.video;
  if ((name === "durationSec" || videoChanged) && next.storyboard.length) {
    const maxShot = marketingShotMaxSeconds(next, marketingDraftProfile(next, configured));
    try { next.storyboard = timeMarketingStoryboard(next.storyboard, next.durationSec, maxShot); }
    catch { /* resolveMarketingSegments shows the error */ }
  }
  return next;
}

/** The ID of a recorded request: the same while the request is unchanged, so a repeat after a lost
 * response replays the saved result instead of paying for another model call. */
export function stableRequestId(ref: { current: { fingerprint: string; id: string } | null }, fingerprint: string,
  newId: () => string = () => crypto.randomUUID()) {
  if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, id: newId() };
  return ref.current.id;
}
