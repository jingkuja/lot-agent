import { capMarketingStoryboard, MARKETING_REVIEW_RULE_VERSION, MarketingDraftSchema, MarketingStoryboardSchema, marketingShotMaxSeconds, planMarketingSegments, resolveMarketingSegments, storyboardScript, timeMarketingStoryboard, type MarketingDraft, type MarketingReview, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { activeMarketingVideoProfile } from "./model.js";
import { parseCreation } from "./creation.js";
import { MarketingTextError } from "./text.js";
import { normalizeMarketingReview } from "./compliance.js";

// Persist this version with the original input. Recovery must never silently
// reinterpret an old receipt with a different parser or current project draft.
export const TEXT_RESULT_VERSION = "marketing-result-v1";
// Review results depend on the local rule table, so a rule change invalidates old receipts.
export const REVIEW_RESULT_VERSION = `marketing-review-v1:${MARKETING_REVIEW_RULE_VERSION}`;
export const PUBLICATION_RESULT_VERSION = "marketing-publication-v1";
export type TextOperationKind = "copy" | "storyboard" | "review" | "publication";
export interface TextOperationResult { draft?: MarketingDraft; analysis?: string; review?: MarketingReview }
export const textResultVersion = (kind: TextOperationKind) => kind === "review" ? REVIEW_RESULT_VERSION : kind === "publication" ? PUBLICATION_RESULT_VERSION : TEXT_RESULT_VERSION;

/** Parse a model answer against the frozen draft and request input of its operation. */
export function parseOperationResult(kind: TextOperationKind, raw: unknown, draft: MarketingDraft, input: { index?: number; locale?: string; fillMissing?: boolean } = {}): TextOperationResult {
  if (kind === "review") {
    const review = normalizeMarketingReview(draft, raw, (input.locale ?? "zh") as "zh" | "en" | "id");
    if (!review) throw new MarketingTextError("内容检查未返回完整且可定位的结果，请重试。", "MARKETING_TEXT_INVALID_RESULT", 503);
    return { review };
  }
  if (kind === "publication") {
    const value = raw as Record<string, unknown> | null;
    // Fill-missing keeps the user's fields as they were when the request began.
    const parsed = MarketingDraftSchema.safeParse({ ...draft,
      publishTitle: input.fillMissing && draft.publishTitle ? draft.publishTitle : value?.publishTitle,
      tags: input.fillMissing && draft.tags ? draft.tags : value?.tags });
    if (!parsed.success || !parsed.data.publishTitle || !parsed.data.tags) throw new MarketingTextError("文案生成失败，请重试。", "MARKETING_TEXT_INVALID_RESULT", 503);
    return { draft: parsed.data, analysis: "" };
  }
  return parseTextResult(kind, raw, draft, input.index);
}
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
    // Only a full-board answer may set the shared look; a single-shot edit keeps it.
    const continuity = selectedIndex === undefined && typeof (raw as { continuity?: unknown }).continuity === "string" ? ((raw as { continuity: string }).continuity).trim() : draft.continuity;
    const updated = MarketingDraftSchema.parse({ ...draft, storyboard, script: storyboardScript(storyboard), continuity });
    resolveMarketingSegments(updated, profile);
    return { draft: updated, analysis: "" };
  } catch {
    throw new MarketingTextError("文案或分镜生成不完整，请重试。", "MARKETING_TEXT_INVALID_RESULT", 503);
  }
}
export function invalidTextResult(error: unknown) {
  return error instanceof MarketingTextError && ["MARKETING_TEXT_INVALID_JSON", "MARKETING_TEXT_INVALID_RESULT"].includes(error.code);
}
