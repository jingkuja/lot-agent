import { marketingAssetIds, type MarketingDraft, type MarketingSegment } from "@lot-agent/core/marketing-video";

export function marketingPresenterRequirement(draft: MarketingDraft): string {
  if (draft.mode !== "avatar" && !draft.assets.portrait) return "";
  return `Mandatory character requirement: the presenter must be visibly on camera in EVERY shot, with a recognizable face and upper body, speaking or demonstrating the product. ${draft.assets.portrait ? "The presenter must match the supplied portrait identity; never substitute another person." : "Create one consistent presenter across all shots."} Include the presenter explicitly in each shot's visual and action. Product details may share the frame with the presenter; never use product-only, scenery-only, hands-only shots or off-screen narration. This requirement takes precedence over conflicting shot directions.`;
}

export function marketingSegmentPrompt(draft: MarketingDraft, segment: MarketingSegment, count: number): string {
  const shot = draft.storyboard?.[segment.index];
  let imageIndex = 0;
  const imageInstructions = (["portrait", "background", "scene"] as const).flatMap(slot =>
    marketingAssetIds(draft.assets[slot]).map(() => `Use image ${++imageIndex} for ${slot === "portrait" ? "the presenter's appearance" : slot === "background" ? "the setting" : "the scene composition and details"}.`));
  return [
    `Create shot ${segment.index + 1} of ${count} for a continuous marketing video. Duration exactly ${segment.durationSec} seconds.`,
    draft.assets.video ? `Create silent visuals illustrating ONLY this script: ${segment.script}. Use video 1 as a reference for movement and composition. Do not generate speech or audio.` : `Narrate ONLY this text, verbatim, finishing within the shot: ${segment.script}`,
    `Keep the same presenter, outfit and environment throughout. Background: ${draft.background}.`,
    draft.assets.video ? "" : `Keep the same voice throughout. Voice style: ${draft.voice}.`,
    ...imageInstructions,
    "Use consistent presenter and product styling.",
    !draft.assets.video && draft.assets.voice ? "Use audio 1 for the narrator's voice." : "",
    shot ? `Shot visual: ${shot.visual}\nSubject actions: ${shot.action}\nCamera direction: ${shot.camera}` : "",
    marketingPresenterRequirement(draft),
    draft.subtitles
      ? draft.assets.video ? `Generate clear, readable on-screen captions using ONLY this shot's script: ${segment.script}. Use consistent styling within safe margins.` : "Generate clear, readable on-screen subtitles matching ONLY this shot's narration verbatim, in the same language and synchronized with the speech. Use consistent subtitle styling and position near the bottom within safe margins across all shots. Do not add any other on-screen text."
      : "Do not add on-screen text or subtitles.",
    "No music, logo or watermark. Do not invent product claims.",
    draft.assets.video ? "" : "Use natural speech with brief pauses.",
  ].join("\n");
}
