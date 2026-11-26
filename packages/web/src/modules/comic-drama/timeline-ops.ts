import {
  comicTimelineOverflow, layoutComicTimeline,
  type ComicEditSource, type ComicTimeline,
} from "@lot-agent/core/comic-drama";

export type OverlayTrack = "voice" | "music" | "sfx" | "subtitles";
export type AudioOverlayItem = ComicTimeline["voice"][number];
export type SubtitleOverlayItem = ComicTimeline["subtitles"][number];
export type OverlayItem = AudioOverlayItem | SubtitleOverlayItem;
export type TimelineAnchor = AudioOverlayItem["anchor"];

export type RulerTick = {
  ms: number;
  label: string;
  major: boolean;
};

export type SnapResult = {
  startMs: number;
  snapLineMs: number | null;
};

export type EdgeSnapResult = {
  ms: number;
  snapLineMs: number | null;
};

export type TimelineMoveResult = {
  timeline: ComicTimeline;
  appliedDeltaMs: number;
  clamped: boolean;
  linkedCount: number;
  newStartMs: number;
};

export type TrackShiftBounds = {
  count: number;
  minStartMs: number;
  maxEndMs: number;
  maxShiftEarlierMs: number;
  maxShiftLaterMs: number;
  totalDurationMs: number;
};

export type TrackShiftResult = {
  timeline: ComicTimeline;
  appliedDeltaMs: number;
  requestedDeltaMs: number;
  clamped: boolean;
  movedCount: number;
  linkedCount: number;
};

export function formatTimelineSec(ms: number): string {
  const sec = Number((ms / 1000).toFixed(2));
  return `${sec}s`;
}

export function computeRulerTicks(totalMs: number, zoom: number): RulerTick[] {
  if (totalMs <= 0) return [];
  const safeZoom = Math.max(1, zoom);
  const visibleMs = totalMs / safeZoom;
  const steps = [500, 1000, 2000, 5000, 10000, 15000, 30000];
  let stepMs = steps[steps.length - 1]!;
  for (const candidate of steps) {
    if (visibleMs / candidate <= 10) {
      stepMs = candidate;
      break;
    }
  }
  const ticks: RulerTick[] = [];
  for (let ms = 0; ms <= totalMs; ms += stepMs) {
    ticks.push({ ms, label: formatTimelineSec(ms), major: true });
  }
  if (ticks.length && ticks[ticks.length - 1]!.ms < totalMs) {
    const tailGap = totalMs - ticks[ticks.length - 1]!.ms;
    if (tailGap >= stepMs * 0.35) {
      ticks.push({ ms: totalMs, label: formatTimelineSec(totalMs), major: false });
    }
  }
  return ticks;
}

export function resolveAnchorForMove(
  _timeline: ComicTimeline,
  layout: ReturnType<typeof layoutComicTimeline>,
  currentAnchor: TimelineAnchor,
  newStartMs: number,
  durationMs: number,
): TimelineAnchor {
  const safeStart = Math.max(0, Math.round(newStartMs));
  const safeDur = Math.max(1, Math.round(durationMs));
  if (currentAnchor.kind === "clip") {
    const clip = layout.video.find(item => item.id === currentAnchor.videoItemId);
    if (clip && safeStart >= clip.startMs && safeStart + safeDur <= clip.endMs) {
      return {
        kind: "clip",
        videoItemId: currentAnchor.videoItemId,
        offsetMs: Math.round(safeStart - clip.startMs),
      };
    }
  }
  return { kind: "timeline", offsetMs: safeStart };
}

export function clampAudioFades<T extends AudioOverlayItem>(item: T, durationMs: number): T {
  const safeDur = Math.max(1, Math.round(durationMs));
  const fadeInMs = Math.min(Math.max(0, Math.round(item.fadeInMs)), safeDur);
  const fadeOutMs = Math.min(Math.max(0, Math.round(item.fadeOutMs)), safeDur - fadeInMs);
  if (fadeInMs === item.fadeInMs && fadeOutMs === item.fadeOutMs) return item;
  return { ...item, fadeInMs, fadeOutMs };
}

export function collectSnapTargets(
  timeline: ComicTimeline,
  layout: ReturnType<typeof layoutComicTimeline>,
  playheadMs: number,
  excludeTrack?: OverlayTrack,
  excludeIds?: ReadonlySet<string>,
): number[] {
  const points = new Set<number>([0, layout.durationMs, Math.round(playheadMs)]);
  for (const clip of layout.video) {
    points.add(clip.startMs);
    points.add(clip.endMs);
  }
  const relevantTracks: OverlayTrack[] = excludeTrack === "voice" || excludeTrack === "subtitles"
    ? ["voice", "subtitles"]
    : excludeTrack ? [excludeTrack] : ["voice", "music", "sfx", "subtitles"];
  for (const track of relevantTracks) {
    const items = timeline[track];
    const placements = layout[track];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const placement = placements[i];
      if (!placement) continue;
      if (track === excludeTrack && excludeIds?.has(item.id)) continue;
      points.add(placement.startMs);
      points.add(placement.endMs);
    }
  }
  return [...points].sort((a, b) => a - b);
}

export function snapTimelineMs(
  rawStartMs: number,
  durationMs: number,
  targets: readonly number[],
  thresholdMs: number,
  totalMs: number,
): SnapResult {
  const maxStart = Math.max(0, totalMs - durationMs);
  const clamped = Math.round(Math.max(0, Math.min(maxStart, rawStartMs)));
  if (thresholdMs <= 0 || !targets.length) return { startMs: clamped, snapLineMs: null };
  let bestDist = thresholdMs + 1;
  let snappedStart = clamped;
  let snapLineMs: number | null = null;
  for (const target of targets) {
    const distStart = Math.abs(clamped - target);
    if (distStart < bestDist && target >= 0 && target <= maxStart) {
      bestDist = distStart;
      snappedStart = target;
      snapLineMs = target;
    }
    const endCandidate = target - durationMs;
    const distEnd = Math.abs(clamped + durationMs - target);
    if (distEnd < bestDist && endCandidate >= 0 && endCandidate <= maxStart) {
      bestDist = distEnd;
      snappedStart = endCandidate;
      snapLineMs = target;
    }
  }
  return { startMs: Math.round(snappedStart), snapLineMs };
}

export function snapEdgeMs(
  rawMs: number,
  targets: readonly number[],
  thresholdMs: number,
  minMs: number,
  maxMs: number,
): EdgeSnapResult {
  const clamped = Math.round(Math.max(minMs, Math.min(maxMs, rawMs)));
  if (thresholdMs <= 0 || !targets.length) return { ms: clamped, snapLineMs: null };
  let bestDist = thresholdMs + 1;
  let snapped = clamped;
  let snapLineMs: number | null = null;
  for (const target of targets) {
    if (target < minMs || target > maxMs) continue;
    const dist = Math.abs(clamped - target);
    if (dist < bestDist) {
      bestDist = dist;
      snapped = target;
      snapLineMs = target;
    }
  }
  return { ms: Math.round(snapped), snapLineMs };
}

function findLinkedSubtitleIds(
  timeline: ComicTimeline,
  layout: ReturnType<typeof layoutComicTimeline>,
  voiceItems: readonly AudioOverlayItem[],
): Set<string> {
  const matchedIds = new Set<string>();
  for (const voice of voiceItems) {
    if (!voice.lineId) continue;
    const voiceIdx = timeline.voice.findIndex(entry => entry.id === voice.id);
    const voiceStart = voiceIdx >= 0 ? (layout.voice[voiceIdx]?.startMs ?? 0) : 0;
    const candidates = timeline.subtitles
      .map((sub, idx) => ({ sub, startMs: layout.subtitles[idx]?.startMs ?? 0 }))
      .filter(entry => entry.sub.lineId === voice.lineId);
    if (!candidates.length) continue;
    if (candidates.length === 1) {
      matchedIds.add(candidates[0]!.sub.id);
      continue;
    }
    const voiceClipId = voice.anchor.kind === "clip" ? voice.anchor.videoItemId : null;
    const sameClip = voiceClipId
      ? candidates.filter(entry => (
        entry.sub.anchor.kind === "clip" && entry.sub.anchor.videoItemId === voiceClipId
      ))
      : [];
    const pool = sameClip.length ? sameClip : candidates;
    let best = pool[0]!;
    let bestDist = Math.abs(best.startMs - voiceStart);
    for (const candidate of pool.slice(1)) {
      const dist = Math.abs(candidate.startMs - voiceStart);
      if (dist < bestDist) {
        best = candidate;
        bestDist = dist;
      }
    }
    matchedIds.add(best.sub.id);
  }
  return matchedIds;
}

export function countLinkedSubtitles(timeline: ComicTimeline, voiceIds?: ReadonlySet<string>): number {
  const layout = layoutComicTimeline(timeline);
  const targets = voiceIds
    ? timeline.voice.filter(item => voiceIds.has(item.id))
    : timeline.voice;
  return findLinkedSubtitleIds(timeline, layout, targets).size;
}

export function moveOverlayItem(
  timeline: ComicTimeline,
  track: OverlayTrack,
  itemId: string,
  targetStartMs: number,
  options?: { linkSubtitles?: boolean },
): TimelineMoveResult {
  const layout = layoutComicTimeline(timeline);
  const index = timeline[track].findIndex(item => item.id === itemId);
  if (index < 0 || layout.durationMs <= 0) {
    return { timeline, appliedDeltaMs: 0, clamped: false, linkedCount: 0, newStartMs: 0 };
  }
  const item = timeline[track][index]!;
  const placement = layout[track][index]!;
  const maxStart = Math.max(0, layout.durationMs - item.durationMs);
  const clampedStart = Math.round(Math.max(0, Math.min(maxStart, targetStartMs)));
  const appliedDeltaMs = clampedStart - placement.startMs;
  const clamped = clampedStart !== Math.round(targetStartMs);
  if (appliedDeltaMs === 0 && item.anchor.kind === "timeline") {
    return { timeline, appliedDeltaMs: 0, clamped, linkedCount: 0, newStartMs: clampedStart };
  }

  const nextAnchor = resolveAnchorForMove(timeline, layout, item.anchor, clampedStart, item.durationMs);
  const nextTrackItems = timeline[track].map(entry => (
    entry.id === item.id ? { ...entry, anchor: nextAnchor } : entry
  ));

  let nextSubtitles = timeline.subtitles;
  let linkedCount = 0;
  if (track === "voice" && options?.linkSubtitles && "lineId" in item && item.lineId && appliedDeltaMs !== 0) {
    const linkedIds = findLinkedSubtitleIds(timeline, layout, [item as AudioOverlayItem]);
    if (linkedIds.size) {
      nextSubtitles = timeline.subtitles.map((sub, subIdx) => {
        if (!linkedIds.has(sub.id)) return sub;
        const subStart = layout.subtitles[subIdx]?.startMs ?? 0;
        const subMax = Math.max(0, layout.durationMs - sub.durationMs);
        const subNextStart = Math.round(Math.max(0, Math.min(subMax, subStart + appliedDeltaMs)));
        linkedCount += 1;
        return {
          ...sub,
          anchor: resolveAnchorForMove(timeline, layout, sub.anchor, subNextStart, sub.durationMs),
        };
      });
    }
  }

  const nextTimeline: ComicTimeline = {
    ...timeline,
    [track]: nextTrackItems,
    ...(track === "voice" ? { subtitles: nextSubtitles } : {}),
  };
  return { timeline: nextTimeline, appliedDeltaMs, clamped, linkedCount, newStartMs: clampedStart };
}

export function getTrackShiftBounds(
  timeline: ComicTimeline,
  track: OverlayTrack,
  fromItemId?: string,
): TrackShiftBounds {
  const layout = layoutComicTimeline(timeline);
  const items = timeline[track];
  const placements = layout[track];
  if (!items.length || !layout.durationMs) {
    return {
      count: 0,
      minStartMs: 0,
      maxEndMs: 0,
      maxShiftEarlierMs: 0,
      maxShiftLaterMs: 0,
      totalDurationMs: layout.durationMs,
    };
  }
  const fromIdx = fromItemId ? items.findIndex(item => item.id === fromItemId) : -1;
  const thresholdStart = fromIdx >= 0 ? (placements[fromIdx]?.startMs ?? 0) : -1;
  let count = 0;
  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = 0;
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i]!;
    if (fromIdx >= 0 && placement.startMs < thresholdStart) continue;
    count += 1;
    if (placement.startMs < minStartMs) minStartMs = placement.startMs;
    if (placement.endMs > maxEndMs) maxEndMs = placement.endMs;
  }
  if (!count) {
    return {
      count: 0,
      minStartMs: 0,
      maxEndMs: 0,
      maxShiftEarlierMs: 0,
      maxShiftLaterMs: 0,
      totalDurationMs: layout.durationMs,
    };
  }
  return {
    count,
    minStartMs,
    maxEndMs,
    maxShiftEarlierMs: Math.max(0, minStartMs),
    maxShiftLaterMs: Math.max(0, layout.durationMs - maxEndMs),
    totalDurationMs: layout.durationMs,
  };
}

export function shiftOverlayTrack(
  timeline: ComicTimeline,
  track: OverlayTrack,
  deltaMs: number,
  options?: { linkSubtitles?: boolean; fromItemId?: string },
): TrackShiftResult {
  const layout = layoutComicTimeline(timeline);
  const items = timeline[track];
  const placements = layout[track];
  const requestedDeltaMs = Math.round(deltaMs);
  const bounds = getTrackShiftBounds(timeline, track, options?.fromItemId);
  if (!bounds.count || !layout.durationMs) {
    return { timeline, appliedDeltaMs: 0, requestedDeltaMs, clamped: false, movedCount: 0, linkedCount: 0 };
  }
  const appliedDeltaMs = requestedDeltaMs < 0
    ? -Math.min(-requestedDeltaMs, bounds.maxShiftEarlierMs)
    : Math.min(requestedDeltaMs, bounds.maxShiftLaterMs);
  const clamped = appliedDeltaMs !== requestedDeltaMs;
  if (appliedDeltaMs === 0) {
    return { timeline, appliedDeltaMs: 0, requestedDeltaMs, clamped, movedCount: 0, linkedCount: 0 };
  }

  const fromIdx = options?.fromItemId ? items.findIndex(item => item.id === options.fromItemId) : -1;
  const thresholdStart = fromIdx >= 0 ? (placements[fromIdx]?.startMs ?? 0) : -1;
  const movedIds = new Set<string>();
  const movedVoiceItems: AudioOverlayItem[] = [];
  const nextTrackItems = items.map((entry, idx) => {
    const placement = placements[idx]!;
    if (fromIdx >= 0 && placement.startMs < thresholdStart) return entry;
    movedIds.add(entry.id);
    if (track === "voice" && "mediaId" in entry) movedVoiceItems.push(entry as AudioOverlayItem);
    const nextStart = placement.startMs + appliedDeltaMs;
    return {
      ...entry,
      anchor: resolveAnchorForMove(timeline, layout, entry.anchor, nextStart, entry.durationMs),
    };
  });

  let nextSubtitles = timeline.subtitles;
  let linkedCount = 0;
  if (track === "voice" && options?.linkSubtitles && movedVoiceItems.length) {
    const linkedIds = findLinkedSubtitleIds(timeline, layout, movedVoiceItems);
    if (linkedIds.size) {
      nextSubtitles = timeline.subtitles.map((sub, subIdx) => {
        if (!linkedIds.has(sub.id)) return sub;
        const subStart = layout.subtitles[subIdx]?.startMs ?? 0;
        const subMax = Math.max(0, layout.durationMs - sub.durationMs);
        const subNextStart = Math.round(Math.max(0, Math.min(subMax, subStart + appliedDeltaMs)));
        linkedCount += 1;
        return {
          ...sub,
          anchor: resolveAnchorForMove(timeline, layout, sub.anchor, subNextStart, sub.durationMs),
        };
      });
    }
  }

  const nextTimeline: ComicTimeline = {
    ...timeline,
    [track]: nextTrackItems,
    ...(track === "voice" ? { subtitles: nextSubtitles } : {}),
  };
  return {
    timeline: nextTimeline,
    appliedDeltaMs,
    requestedDeltaMs,
    clamped,
    movedCount: movedIds.size,
    linkedCount,
  };
}

export function resizeOverlayItem(
  timeline: ComicTimeline,
  track: OverlayTrack,
  itemId: string,
  edge: "start" | "end",
  targetMs: number,
  sourceDurationMs?: number,
): ComicTimeline {
  const layout = layoutComicTimeline(timeline);
  const index = timeline[track].findIndex(item => item.id === itemId);
  if (index < 0 || layout.durationMs <= 0) return timeline;
  const item = timeline[track][index]!;
  const placement = layout[track][index]!;
  const minDur = Math.max(1, Math.min(100, item.durationMs));

  if (edge === "end") {
    const capBySource = "mediaId" in item && !item.loop && sourceDurationMs !== undefined
      ? placement.startMs + Math.max(0, sourceDurationMs - item.sourceInMs)
      : layout.durationMs;
    const maxEnd = Math.min(layout.durationMs, capBySource);
    const minEnd = Math.min(maxEnd, placement.startMs + minDur);
    const nextEnd = Math.round(Math.max(minEnd, Math.min(maxEnd, targetMs)));
    const nextDuration = Math.max(1, nextEnd - placement.startMs);
    const nextAnchor = resolveAnchorForMove(timeline, layout, item.anchor, placement.startMs, nextDuration);
    const nextItems = timeline[track].map(entry => {
      if (entry.id !== itemId) return entry;
      const updated = { ...entry, anchor: nextAnchor, durationMs: nextDuration };
      return "mediaId" in updated ? clampAudioFades(updated as AudioOverlayItem, nextDuration) : updated;
    });
    return { ...timeline, [track]: nextItems };
  }

  const endMs = Math.min(layout.durationMs, placement.endMs);
  const minStart = "mediaId" in item
    ? (item.loop ? 0 : Math.max(0, placement.startMs - item.sourceInMs))
    : 0;
  const maxStart = Math.max(minStart, endMs - minDur);
  const nextStart = Math.round(Math.max(minStart, Math.min(maxStart, targetMs)));
  const nextDuration = Math.max(1, endMs - nextStart);
  const nextAnchor = resolveAnchorForMove(timeline, layout, item.anchor, nextStart, nextDuration);
  const nextItems = timeline[track].map(entry => {
    if (entry.id !== itemId) return entry;
    if ("mediaId" in entry) {
      const audioEntry = entry as AudioOverlayItem;
      const rawSourceIn = Math.max(0, audioEntry.sourceInMs + (nextStart - placement.startMs));
      const nextSourceIn = audioEntry.loop && sourceDurationMs && sourceDurationMs > 0
        ? ((rawSourceIn % sourceDurationMs) + sourceDurationMs) % sourceDurationMs
        : rawSourceIn;
      const updated = clampAudioFades(
        { ...audioEntry, anchor: nextAnchor, durationMs: nextDuration, sourceInMs: nextSourceIn },
        nextDuration,
      );
      return updated;
    }
    return { ...entry, anchor: nextAnchor, durationMs: nextDuration };
  });
  return { ...timeline, [track]: nextItems };
}

function fixSingleOverflowItem<T extends OverlayItem>(
  entry: T,
  startMs: number,
  totalDurationMs: number,
): T {
  const safeTotal = Math.max(1, totalDurationMs);
  if (startMs >= 0 && startMs + entry.durationMs <= safeTotal) {
    return { ...entry, anchor: { kind: "timeline", offsetMs: startMs } };
  }
  const clampedStart = Math.max(0, Math.min(safeTotal - 1, Math.round(startMs)));
  const clampedDur = Math.max(1, Math.min(entry.durationMs, safeTotal - clampedStart));
  const updated = {
    ...entry,
    anchor: { kind: "timeline" as const, offsetMs: clampedStart },
    durationMs: clampedDur,
  };
  return "mediaId" in updated ? clampAudioFades(updated as AudioOverlayItem, clampedDur) as T : updated;
}

export function fixOverlayOverflow(
  timeline: ComicTimeline,
  track: OverlayTrack,
  itemId: string,
): ComicTimeline {
  const layout = layoutComicTimeline(timeline);
  if (layout.durationMs <= 0) return timeline;
  const index = timeline[track].findIndex(item => item.id === itemId);
  if (index < 0) return timeline;
  const placement = layout[track][index]!;
  return {
    ...timeline,
    [track]: timeline[track].map((entry, i) => (
      i === index ? fixSingleOverflowItem(entry, placement.startMs, layout.durationMs) : entry
    )),
  };
}

export function fixAllTimelineOverflows(timeline: ComicTimeline): ComicTimeline {
  const layout = layoutComicTimeline(timeline);
  if (layout.durationMs <= 0) return timeline;
  const overflowSet = new Set(comicTimelineOverflow(timeline));
  if (!overflowSet.size) return timeline;
  const fixTrack = <T extends OverlayItem>(items: T[], placements: { startMs: number }[]) =>
    items.map((entry, idx) => (
      overflowSet.has(entry.id)
        ? fixSingleOverflowItem(entry, placements[idx]?.startMs ?? 0, layout.durationMs)
        : entry
    ));
  return {
    ...timeline,
    voice: fixTrack(timeline.voice, layout.voice),
    sfx: fixTrack(timeline.sfx, layout.sfx),
    music: fixTrack(timeline.music, layout.music),
    subtitles: fixTrack(timeline.subtitles, layout.subtitles),
  };
}

export function getOverlayItemTitle(
  timeline: ComicTimeline,
  track: "video" | OverlayTrack,
  index: number,
  videoSources: readonly ComicEditSource[],
  audioNames: Readonly<Record<string, string>>,
  translate: (key: string, params?: readonly (string | number)[]) => string,
): string {
  if (track === "video") {
    const clip = timeline.video[index];
    const source = clip && videoSources.find(meta => meta.takeId === clip.takeId);
    return source?.scene || source?.seriesTitle || translate("视频轨");
  }
  if (track === "subtitles") {
    return timeline.subtitles[index]?.text ?? translate("字幕轨");
  }
  const audio = timeline[track][index];
  if (track === "voice") {
    const label = translate("配音 {0}", [index + 1]);
    const matched = audio?.lineId
      ? timeline.subtitles.find(sub => sub.lineId === audio.lineId)
      : undefined;
    return matched ? `${label} · ${matched.text}` : label;
  }
  const named = audio ? audioNames[audio.mediaId] : undefined;
  if (named) return named;
  return translate(track === "music" ? "音乐 {0}" : "音效 {0}", [index + 1]);
}
