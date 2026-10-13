import type { MarketingDraft, MarketingSegment } from "@lot-agent/core/marketing-video";

export function marketingSegmentPrompt(draft: MarketingDraft, segment: MarketingSegment, count: number): string {
  const shot = draft.storyboard?.[segment.index];
  return [
    `Create shot ${segment.index + 1} of ${count} for a continuous marketing video. Duration exactly ${segment.durationSec} seconds.`,
    `Narrate ONLY this text, verbatim, finishing within the shot: ${segment.script}`,
    `Keep the same presenter, outfit, environment and voice throughout. Background: ${draft.background}. Voice style: ${draft.voice}.`,
    draft.assets.portrait ? "Use image 1 for the presenter's appearance." : "Use consistent presenter and product styling.",
    draft.assets.background ? `Use image ${draft.assets.portrait ? 2 : 1} for the setting.` : "",
    draft.assets.voice ? "Use audio 1 for the narrator's voice." : "",
    shot ? `Shot visual: ${shot.visual}\nSubject actions: ${shot.action}\nCamera direction: ${shot.camera}` : "",
    draft.subtitles
      ? "Generate clear, readable on-screen subtitles matching ONLY this shot's narration verbatim, in the same language and synchronized with the speech. Use consistent subtitle styling and position near the bottom within safe margins across all shots. Do not add any other on-screen text."
      : "Do not add on-screen text or subtitles.",
    "No music, logo or watermark. Use natural speech with brief pauses. Do not invent product claims.",
  ].join("\n");
}
