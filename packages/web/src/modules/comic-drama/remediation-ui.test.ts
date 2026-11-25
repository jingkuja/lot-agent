import { describe, expect, it } from "vitest";
import { comicTimelineSchema, layoutComicTimeline, type ComicDramaClip } from "@lot-agent/core/comic-drama";
import { computeComicBatchPlan } from "./batch-plan.js";
import { computeOverlayAudioStates, effectiveVideoAudioState } from "./preview-audio.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeClip(n: number, opts?: { keyframeApproved?: boolean; adoptedVideoTakeId?: string | null; keyframeState?: "none" | "running" }): ComicDramaClip {
  return {
    id: uuid(n),
    revision: 1,
    selectionRevision: 1,
    ordinal: n,
    draft: {
      schemaVersion: 1,
      durationMs: 6000,
      scene: `分镜 ${n}`,
      shots: [{ id: uuid(100 + n), framingKey: "medium", movementKey: "fixed", description: "描述", durationShare: 100 }],
      lines: [],
    },
    progress: {
      keyframeState: opts?.keyframeState ?? (opts?.keyframeApproved ? "ready" : "none"),
      keyframeMediaId: opts?.keyframeApproved ? uuid(200 + n) : null,
      keyframeApproved: !!opts?.keyframeApproved,
      keyframeStale: false,
      videoState: opts?.adoptedVideoTakeId ? "ready" : "none",
      videoTakeCount: opts?.adoptedVideoTakeId ? 1 : 0,
      adoptedVideoTakeId: opts?.adoptedVideoTakeId ?? null,
      adoptedVideoVersion: opts?.adoptedVideoTakeId ? 1 : null,
      adoptedVideoMediaId: opts?.adoptedVideoTakeId ? uuid(300 + n) : null,
      adoptedStale: false,
      castSnapshotStale: false,
    },
  };
}

describe("P2 #10: batch quick generation shows 10 + remainder and avoids silent fallback when completed", () => {
  it("splits 12 pending clips into a batch of 10 plus 2 remaining", () => {
    const clips = Array.from({ length: 12 }, (_, i) => makeClip(i + 1));
    const plan = computeComicBatchPlan(clips, "keyframe");
    expect(plan.pendingIds).toHaveLength(12);
    expect(plan.batchIds).toHaveLength(10);
    expect(plan.remainingCount).toBe(2);
    expect(plan.allCompleted).toBe(false);
  });

  it("reports allCompleted with empty batchIds when every keyframe is approved (no fallback to first 10)", () => {
    const clips = Array.from({ length: 12 }, (_, i) => makeClip(i + 1, { keyframeApproved: true }));
    const plan = computeComicBatchPlan(clips, "keyframe");
    expect(plan.allCompleted).toBe(true);
    expect(plan.pendingIds).toEqual([]);
    expect(plan.batchIds).toEqual([]);
    expect(plan.busyIds).toEqual([]);
    expect(plan.remainingCount).toBe(0);

    const busyClips = [makeClip(1, { keyframeState: "running" }), makeClip(2)];
    const busyPlan = computeComicBatchPlan(busyClips, "keyframe");
    expect(busyPlan.busyCount).toBe(1);
    expect(busyPlan.busyIds).toEqual([uuid(1)]);
  });
});

describe("P2 #11: preview player respects video clip volume/mute and resolves overlay audio tracks by timeline position", () => {
  it("mutes video audio when clip volume is 0 and preserves gain up to 2.0", () => {
    expect(effectiveVideoAudioState(0, true)).toEqual({ muted: true, elementVolume: 0, gain: 0 });
    expect(effectiveVideoAudioState(0.5, true)).toEqual({ muted: false, elementVolume: 0.5, gain: 0.5 });
    expect(effectiveVideoAudioState(1.6, true)).toEqual({ muted: false, elementVolume: 1, gain: 1.6 });
    expect(effectiveVideoAudioState(1, false)).toEqual({ muted: true, elementVolume: 0, gain: 0 });
  });

  it("resolves active dialogue, SFX and looping music at timeline playhead and respects track mute toggles", () => {
    const videoId = uuid(1);
    const voiceMedia = uuid(2);
    const sfxMedia = uuid(3);
    const musicMedia = uuid(4);
    const timeline = comicTimelineSchema.parse({
      schemaVersion: 1,
      aspectRatio: "9:16",
      video: [{
        id: videoId, takeId: uuid(10), sourceDurationMs: 8000, inMs: 0, outMs: 8000,
        volume: 0, transitionIn: { kind: "cut", durationMs: 0 },
      }],
      voice: [{
        id: uuid(20), mediaId: voiceMedia, anchor: { kind: "clip", videoItemId: videoId, offsetMs: 1000 },
        durationMs: 2000, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
      }],
      sfx: [{
        id: uuid(21), mediaId: sfxMedia, anchor: { kind: "clip", videoItemId: videoId, offsetMs: 1500 },
        durationMs: 1000, sourceInMs: 100, volume: 0.8, fadeInMs: 0, fadeOutMs: 0, loop: false,
      }],
      music: [{
        id: uuid(22), mediaId: musicMedia, anchor: { kind: "timeline", offsetMs: 0 },
        durationMs: 8000, sourceInMs: 0, volume: 0.4, fadeInMs: 500, fadeOutMs: 500, loop: true,
      }],
      subtitles: [],
    });
    const layout = layoutComicTimeline(timeline);
    const audioSources = [
      { id: voiceMedia, durationMs: 2500 },
      { id: sfxMedia, durationMs: 1500 },
      { id: musicMedia, durationMs: 1000 }, // loops every 1000ms
    ];

    const at1800 = computeOverlayAudioStates(timeline, layout, audioSources, 1800, {
      video: true, voice: true, sfx: true, music: true,
    });
    expect(at1800.map(item => [item.track, item.sourceTimeMs, Number(item.gain.toFixed(2))])).toEqual([
      ["voice", 800, 1],
      ["sfx", 400, 0.8],
      ["music", 800, 0.4],
    ]);

    // Muting SFX isolates voice + music only
    const sfxMuted = computeOverlayAudioStates(timeline, layout, audioSources, 1800, {
      video: true, voice: true, sfx: false, music: true,
    });
    expect(sfxMuted.map(item => item.track)).toEqual(["voice", "music"]);
  });
});
