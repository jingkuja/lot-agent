import type { ComicDramaClip, ComicGenerationMode } from "@lot-agent/core/comic-drama";

export const COMIC_BATCH_LIMIT = 10;

export type ComicBatchPlan = {
  totalCount: number;
  pendingIds: string[];
  batchIds: string[];
  remainingCount: number;
  busyCount: number;
  blockedCount: number;
  completedCount: number;
  allCompleted: boolean;
};

const ACTIVE_STATES = new Set(["pending", "running", "recoverable", "unknown"]);

/** Partition episode clips into pending batch (<=10), remainder, busy, blocked and completed counts without implicit fallback. */
export function computeComicBatchPlan(
  clips: readonly ComicDramaClip[],
  mode: ComicGenerationMode,
): ComicBatchPlan {
  const pendingIds: string[] = [];
  let busyCount = 0;
  let blockedCount = 0;
  let completedCount = 0;

  for (const clip of clips) {
    const p = clip.progress;
    if (mode === "keyframe") {
      const done = Boolean(p?.keyframeApproved && !p?.keyframeStale);
      const busy = Boolean(p && ACTIVE_STATES.has(p.keyframeState));
      if (done) completedCount += 1;
      else if (busy) busyCount += 1;
      else pendingIds.push(clip.id);
    } else {
      const done = Boolean(p?.adoptedVideoTakeId && !p?.adoptedStale);
      const busy = Boolean(p && ACTIVE_STATES.has(p.videoState));
      const needsFrame = mode === "from_keyframe" && !p?.keyframeApproved;
      if (done) completedCount += 1;
      else if (busy) busyCount += 1;
      else if (needsFrame) blockedCount += 1;
      else pendingIds.push(clip.id);
    }
  }

  const batchIds = pendingIds.slice(0, COMIC_BATCH_LIMIT);
  const remainingCount = Math.max(0, pendingIds.length - batchIds.length);
  const allCompleted = clips.length > 0 && pendingIds.length === 0 && busyCount === 0 && blockedCount === 0;
  return {
    totalCount: clips.length,
    pendingIds,
    batchIds,
    remainingCount,
    busyCount,
    blockedCount,
    completedCount,
    allCompleted,
  };
}
