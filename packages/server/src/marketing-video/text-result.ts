import { capMarketingStoryboard, MarketingDraftSchema, MarketingStoryboardSchema, marketingShotMaxSeconds, planMarketingSegments, resolveMarketingSegments, storyboardScript, timeMarketingStoryboard, type MarketingDraft, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { activeMarketingVideoProfile } from "./model.js";
import { parseCreation } from "./creation.js";
import { MarketingTextError } from "./text.js";

// Persist this version with the original input. Recovery must never silently
// reinterpret an old receipt with a different parser or current project draft.
export const TEXT_RESULT_VERSION = "marketing-result-v1";
export function parseTextResult(kind: "copy" | "storyboard", raw: unknown, draft: MarketingDraft, selectedIndex?: number, profile: MarketingVideoProfile = activeMarketingVideoProfile()) {
  try {
    if (kind === "copy") return parseCreation(raw, draft, profile);
    const maxShot = marketingShotMaxSeconds(draft, profile);
    const initial = draft.storyboard.length ? capMarketingStoryboard(draft.storyboard, draft, profile) : planMarketingSegments(draft.script, draft.durationSec, maxShot)
      .map(part => ({ durationSec: part.durationSec, script: part.script, visual: "", action: "", camera: "" }));
    const shots = MarketingStoryboardSchema.parse((raw as { shots?: unknown })?.shots);
    if (!shots.length || (selectedIndex !== undefined && (shots.length !== 1 || !initial[selectedIndex]))) throw new Error("Invalid shots");
    const storyboard = selectedIndex === undefined ? timeMarketingStoryboard(shots, draft.durationSec, maxShot)
      : initial.map((shot, index) => index === selectedIndex ? { ...shots[0], durationSec: shot.durationSec } : shot);
    const updated = MarketingDraftSchema.parse({ ...draft, storyboard, script: storyboardScript(storyboard) });
    resolveMarketingSegments(updated, profile);
    return { draft: updated, analysis: "" };
  } catch {
    throw new MarketingTextError("文案或分镜生成不完整，请重试。", "MARKETING_TEXT_INVALID_RESULT", 503);
  }
}
export function invalidTextResult(error: unknown) {
  return error instanceof MarketingTextError && ["MARKETING_TEXT_INVALID_JSON", "MARKETING_TEXT_INVALID_RESULT"].includes(error.code);
}
