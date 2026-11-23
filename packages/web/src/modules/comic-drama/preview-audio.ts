import { layoutComicTimeline, type ComicEditAudioSource, type ComicTimeline } from "@lot-agent/core/comic-drama";

export type PreviewAudioTrack = "voice" | "sfx" | "music";
export type PreviewTrackToggles = {
  video: boolean;
  voice: boolean;
  sfx: boolean;
  music: boolean;
};

export type EffectiveVideoAudioState = {
  muted: boolean;
  elementVolume: number;
  gain: number;
};

export type ActiveOverlayAudioState = {
  key: string;
  track: PreviewAudioTrack;
  id: string;
  mediaId: string;
  sourceTimeMs: number;
  elementVolume: number;
  gain: number;
};

/** Compute effective video audio playback state matching server export mute/volume semantics (0 = muted, up to 2.0 gain). */
export function effectiveVideoAudioState(clipVolume: number, trackEnabled: boolean): EffectiveVideoAudioState {
  if (!trackEnabled || !Number.isFinite(clipVolume) || clipVolume <= 0) {
    return { muted: true, elementVolume: 0, gain: 0 };
  }
  const clamped = Math.min(2, Math.max(0, clipVolume));
  return {
    muted: false,
    elementVolume: Math.min(1, clamped),
    gain: clamped,
  };
}

/** Resolve all active dialogue, SFX and BGM blocks at a given timeline playhead position (ms). */
export function computeOverlayAudioStates(
  timeline: ComicTimeline,
  layout: ReturnType<typeof layoutComicTimeline>,
  audioSources: readonly ComicEditAudioSource[],
  positionMs: number,
  enabled: PreviewTrackToggles,
): ActiveOverlayAudioState[] {
  const durationByMedia = new Map(audioSources.map(src => [src.id, src.durationMs]));
  const tracks: readonly PreviewAudioTrack[] = ["voice", "sfx", "music"];
  const active: ActiveOverlayAudioState[] = [];

  for (const track of tracks) {
    if (!enabled[track]) continue;
    const items = timeline[track];
    const placements = layout[track];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const placement = placements[i];
      if (!placement || positionMs < placement.startMs || positionMs >= placement.endMs) continue;
      if (item.volume <= 0) continue;
      const elapsedMs = Math.max(0, positionMs - placement.startMs);
      const sourceDurationMs = durationByMedia.get(item.mediaId);
      let sourceTimeMs = item.sourceInMs + elapsedMs;
      if (item.loop && sourceDurationMs && sourceDurationMs > item.sourceInMs) {
        const spanMs = sourceDurationMs - item.sourceInMs;
        sourceTimeMs = item.sourceInMs + (elapsedMs % spanMs);
      } else if (sourceDurationMs && sourceTimeMs >= sourceDurationMs) {
        continue;
      }
      const fadeIn = item.fadeInMs > 0 ? Math.min(1, elapsedMs / item.fadeInMs) : 1;
      const fadeOut = item.fadeOutMs > 0 ? Math.min(1, Math.max(0, placement.endMs - positionMs) / item.fadeOutMs) : 1;
      const gain = Math.min(2, Math.max(0, item.volume * fadeIn * fadeOut));
      if (gain <= 0) continue;
      active.push({
        key: `${track}:${item.id}`,
        track,
        id: item.id,
        mediaId: item.mediaId,
        sourceTimeMs,
        elementVolume: Math.min(1, gain),
        gain,
      });
    }
  }

  return active;
}
