import { marketingShotMaxSeconds, timeMarketingStoryboard, type MarketingDraft, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";

/** The draft after one field changes. New copy drops the old shots. A new duration re-times the
 * shots, or drops them when they no longer fit. Adding or removing the reference video records what
 * the board was planned for and re-times it to the new shot limit. */
export function withDraftField<K extends keyof MarketingDraft>(current: MarketingDraft, name: K, value: MarketingDraft[K],
  profile: MarketingVideoProfile): MarketingDraft {
  const next = { ...current, [name]: value };
  if (value === current[name]) return next;
  if (name === "script") next.storyboard = [];
  if (name === "durationSec" && next.storyboard.length) {
    try { next.storyboard = timeMarketingStoryboard(next.storyboard, next.durationSec, marketingShotMaxSeconds(next, profile)); }
    catch { next.storyboard = []; }
  }
  // A reference video may lower the shot cap; keep the board and let the plan report conflicts.
  if (name === "assets" && !!next.assets.video !== !!current.assets.video && next.storyboard.length) {
    // Older boards carry no record; they were planned before this change.
    next.storyboardAudio ??= !current.assets.video;
    try { next.storyboard = timeMarketingStoryboard(next.storyboard, next.durationSec, marketingShotMaxSeconds(next, profile)); }
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
