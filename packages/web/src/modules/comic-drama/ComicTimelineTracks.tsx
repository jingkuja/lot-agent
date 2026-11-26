import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  comicOverlayTracks, comicTimelineOverflow, layoutComicTimeline, type ComicEditAudioSource, type ComicEditSource,
  type ComicLibraryPage, type ComicMaterial, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { MediaPreview } from "./LibraryParts.js";
import { comicLibraryApi } from "./library-api.js";
import {
  collectSnapTargets, computeRulerTicks, countLinkedSubtitles, fixAllTimelineOverflows, fixOverlayOverflow,
  formatTimelineSec, getOverlayItemTitle, getTrackShiftBounds, moveOverlayItem, resizeOverlayItem,
  shiftOverlayTrack, snapEdgeMs, snapTimelineMs,
} from "./timeline-ops.js";

type Overlay = typeof comicOverlayTracks[number];
type Track = "video" | Overlay;
type Audio = ComicTimeline["voice"][number];
type Subtitle = ComicTimeline["subtitles"][number];
type Anchor = Audio["anchor"];
type Selection = { track: Overlay; id: string };
type ShiftPanel = { track: Overlay; scope: "all" | "from_selected" };

type DragSession = {
  kind: "move" | "resize-start" | "resize-end";
  track: Overlay;
  itemId: string;
  pointerId: number;
  originX: number;
  laneWidth: number;
  initialStartMs: number;
  initialEndMs: number;
  currentStartMs: number;
  currentEndMs: number;
  deltaMs: number;
  snapLineMs: number | null;
  activated: boolean;
  sourceDurationMs?: number;
  linkedSubIds: Set<string>;
};

const tracks: Track[] = ["video", ...comicOverlayTracks];
const names: Record<Track, string> = {
  video: "视频轨", voice: "配音轨", sfx: "音效轨", music: "音乐轨", subtitles: "字幕轨",
};
const zoomLevels = [1, 1.5, 2, 3, 4, 6] as const;
const seconds = (value: number) => value / 1000;
const roundSec = (value: number) => Number((value / 1000).toFixed(2));
const ms = (form: FormData, field: string) => Math.round(Number(form.get(field)) * 1000);
const position = (form: FormData): Anchor => {
  const id = String(form.get("anchor"));
  const offsetMs = ms(form, "offset");
  return id === "timeline" ? { kind: "timeline", offsetMs } : { kind: "clip", videoItemId: id, offsetMs };
};

function stack(items: ReturnType<typeof layoutComicTimeline>[Track]) {
  const ends: number[] = [];
  const lanes = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.startMs - b.startMs).map(item => {
    const vacant = ends.findIndex(end => end <= item.startMs);
    const lane = vacant === -1 ? ends.length : vacant;
    ends[lane] = item.endMs;
    return { ...item, lane };
  });
  return { lanes, rows: Math.max(1, ends.length) };
}

function tryCapture(target: HTMLElement, pointerId: number) {
  try { target.setPointerCapture?.(pointerId); } catch { /* ignore in non-browser test DOM */ }
}

function tryRelease(target: HTMLElement, pointerId: number) {
  try {
    if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
  } catch { /* ignore */ }
}

export function ComicTimelineTracks({
  timeline, videoSources, audioSources, audioNames = {}, selectedVideo, positionMs, seek, selectVideo, update, disabled,
  canUndo = false, canRedo = false, onUndo, onRedo, onInteractingChange,
}: {
  timeline: ComicTimeline; videoSources: ComicEditSource[]; audioSources: ComicEditAudioSource[];
  audioNames?: Readonly<Record<string, string>>; selectedVideo?: string;
  positionMs: number; seek: (ms: number) => void; selectVideo: (id: string) => void;
  update: (timeline: ComicTimeline) => void; disabled: boolean;
  canUndo?: boolean; canRedo?: boolean; onUndo?: () => void; onRedo?: () => void;
  onInteractingChange?: (interacting: boolean) => void;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<Selection>();
  const [picker, setPicker] = useState<"music" | "sfx">();
  const [added, setAdded] = useState<ComicEditAudioSource[]>([]);
  const [pickedNames, setPickedNames] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [trackNotice, setTrackNotice] = useState("");
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [linkSubtitles, setLinkSubtitles] = useState(true);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [shiftPanel, setShiftPanel] = useState<ShiftPanel | null>(null);
  const [shiftSeconds, setShiftSeconds] = useState("2");
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const suppressClickRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => onInteractingChange?.(false), [onInteractingChange]);

  const zoom = zoomLevels[zoomIndex] ?? 1;
  const layout = layoutComicTimeline(timeline);
  const total = Math.max(1, layout.durationMs);
  const playhead = Math.min(positionMs, layout.durationMs);
  const overflow = new Set(comicTimelineOverflow(timeline));
  const selected = selection && timeline[selection.track].find(item => item.id === selection.id);
  const selectedIndex = selection && selected
    ? timeline[selection.track].findIndex(item => item.id === selected.id)
    : -1;
  const selectedPlacement = selection && selectedIndex >= 0 ? layout[selection.track][selectedIndex] : undefined;
  const selectedAudio = selected && "mediaId" in selected ? selected : undefined;
  const mergedAudioSources = [...audioSources, ...added];
  const mergedAudioNames = { ...audioNames, ...pickedNames };
  const length = selectedAudio && mergedAudioSources.find(source => source.id === selectedAudio.mediaId)?.durationMs;
  const hasVoiceOrSub = timeline.voice.length > 0 || timeline.subtitles.length > 0;
  const rulerTicks = computeRulerTicks(layout.durationMs, zoom);
  const cutMarkersMs = layout.video.slice(1).map(clip => clip.startMs);

  const choose = (track: Track, id: string, startMs: number) => {
    setFormError("");
    if (track === "video") { setSelection(undefined); selectVideo(id); }
    else setSelection({ track, id });
    seek(startMs);
  };

  const replace = (edit: Audio | Subtitle) => {
    if (!selection) return;
    const track = selection.track;
    if ("mediaId" in edit && track !== "subtitles") {
      if ((length && (edit.sourceInMs >= length || (!edit.loop && edit.sourceInMs + edit.durationMs > length))) ||
        edit.fadeInMs + edit.fadeOutMs > edit.durationMs) {
        setFormError("请检查音频源范围及淡入淡出时长");
        return;
      }
      update({ ...timeline, [track]: timeline[track].map(item => item.id === edit.id ? edit : item) });
    } else if (!("mediaId" in edit) && track === "subtitles") {
      update({ ...timeline, subtitles: timeline.subtitles.map(item => item.id === edit.id ? edit : item) });
    }
    setFormError("");
  };

  const insertAudio = (track: "music" | "sfx", material: ComicMaterial) => {
    const durationMs = material.media.durationMs;
    if (!durationMs) return;
    const offsetMs = playhead < layout.durationMs ? playhead : 0;
    const id = crypto.randomUUID();
    const edit: Audio = {
      id, mediaId: material.media.id, anchor: { kind: "timeline", offsetMs },
      durationMs: Math.min(durationMs, layout.durationMs - offsetMs), sourceInMs: 0,
      volume: track === "music" ? 0.3 : 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
    };
    setAdded(values => [...values, { id: material.media.id, durationMs }]);
    setPickedNames(prev => ({ ...prev, [material.media.id]: material.name }));
    update({ ...timeline, [track]: [...timeline[track], edit] });
    setSelection({ track, id });
    setFormError("");
    setPicker(undefined);
  };

  const addSubtitle = (form: FormData) => {
    const text = String(form.get("text") ?? "").trim();
    if (!text) return;
    const offsetMs = playhead < layout.durationMs ? playhead : 0;
    const id = crypto.randomUUID();
    update({
      ...timeline,
      subtitles: [...timeline.subtitles, {
        id, text, anchor: { kind: "timeline", offsetMs },
        durationMs: Math.min(2500, layout.durationMs - offsetMs),
      }],
    });
    setFormError("");
    setSelection({ track: "subtitles", id });
  };

  const itemTitle = (track: Track, index: number) =>
    getOverlayItemTitle(timeline, track, index, videoSources, mergedAudioNames, t);

  const applyNudge = (track: Overlay, itemId: string, targetStartMs: number) => {
    const result = moveOverlayItem(timeline, track, itemId, targetStartMs, { linkSubtitles });
    update(result.timeline);
    setFormError("");
    if (result.appliedDeltaMs === 0) {
      setTrackNotice(t("已到达时间线边界，无法继续移动"));
      return;
    }
    const dir = result.appliedDeltaMs > 0 ? "+" : "";
    const deltaText = `${dir}${roundSec(result.appliedDeltaMs)}s`;
    if (result.linkedCount > 0) {
      setTrackNotice(t("已移动 {0}（同步移动 {1} 条字幕）", [deltaText, result.linkedCount]));
    } else {
      setTrackNotice(t("已移动 {0}", [deltaText]));
    }
  };

  const applyTrackShift = (track: Overlay, deltaMs: number, scope: ShiftPanel["scope"]) => {
    if (!deltaMs || !Number.isFinite(deltaMs)) return;
    const fromItemId = scope === "from_selected" && selection?.track === track ? selection.id : undefined;
    const result = shiftOverlayTrack(timeline, track, deltaMs, { linkSubtitles, fromItemId });
    if (!result.movedCount) {
      setTrackNotice(t("该轨道已到达边界，无法继续平移"));
      return;
    }
    update(result.timeline);
    setFormError("");
    const appliedText = `${result.appliedDeltaMs > 0 ? "+" : ""}${roundSec(result.appliedDeltaMs)}s`;
    if (result.clamped && result.linkedCount > 0) {
      setTrackNotice(t("已平移 {0} 条（受总时长限制实际移动 {1}，同步 {2} 条字幕）", [
        result.movedCount, appliedText, result.linkedCount,
      ]));
    } else if (result.clamped) {
      setTrackNotice(t("已平移 {0} 条（受总时长限制实际移动 {1}）", [result.movedCount, appliedText]));
    } else if (result.linkedCount > 0) {
      setTrackNotice(t("已平移 {0} 条 {1}（同步移动 {2} 条字幕）", [
        result.movedCount, appliedText, result.linkedCount,
      ]));
    } else {
      setTrackNotice(t("已平移 {0} 条（{1}）", [result.movedCount, appliedText]));
    }
  };

  const seekAtPointer = (el: HTMLElement, clientX: number) => {
    if (!layout.durationMs) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seek(Math.round(ratio * layout.durationMs));
  };

  const beginClipDrag = (
    event: ReactPointerEvent<HTMLElement>,
    kind: DragSession["kind"],
    track: Overlay,
    itemId: string,
    startMs: number,
    endMs: number,
  ) => {
    if (disabled || !layout.durationMs || event.button !== 0) return;
    if (kind !== "move") event.stopPropagation();
    const laneEl = event.currentTarget.closest(".comic-track-lane") as HTMLElement | null;
    const laneWidth = laneEl?.getBoundingClientRect().width ?? 0;
    if (laneWidth <= 0) return;
    const item = timeline[track].find(entry => entry.id === itemId);
    const sourceDurationMs = item && "mediaId" in item
      ? mergedAudioSources.find(src => src.id === item.mediaId)?.durationMs
      : undefined;
    const linkedSubIds = new Set<string>();
    if (kind === "move" && track === "voice" && linkSubtitles && item && "lineId" in item && item.lineId) {
      for (const sub of timeline.subtitles) {
        if (sub.lineId === item.lineId) linkedSubIds.add(sub.id);
      }
    }
    tryCapture(event.currentTarget, event.pointerId);
    setDrag({
      kind, track, itemId, pointerId: event.pointerId, originX: event.clientX, laneWidth,
      initialStartMs: startMs, initialEndMs: endMs, currentStartMs: startMs, currentEndMs: endMs,
      deltaMs: 0, snapLineMs: null, activated: false, sourceDurationMs, linkedSubIds,
    });
  };

  const moveClipDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.originX;
    if (!drag.activated && Math.abs(dx) < 4) return;
    if (!drag.activated) onInteractingChange?.(true);
    const rawDeltaMs = Math.round((dx / drag.laneWidth) * total);
    const snapThresholdMs = Math.max(80, Math.round((10 / drag.laneWidth) * total));
    const targets = snapEnabled
      ? collectSnapTargets(timeline, layout, playhead, drag.track, new Set([drag.itemId]))
      : [];

    if (drag.kind === "move") {
      const dur = drag.initialEndMs - drag.initialStartMs;
      const rawStart = drag.initialStartMs + rawDeltaMs;
      const snapped = snapEnabled
        ? snapTimelineMs(rawStart, dur, targets, snapThresholdMs, layout.durationMs)
        : {
          startMs: Math.round(Math.max(0, Math.min(Math.max(0, layout.durationMs - dur), rawStart))),
          snapLineMs: null,
        };
      setDrag({
        ...drag,
        activated: true,
        currentStartMs: snapped.startMs,
        currentEndMs: snapped.startMs + dur,
        deltaMs: snapped.startMs - drag.initialStartMs,
        snapLineMs: snapped.snapLineMs,
      });
      return;
    }

    const itemObj = timeline[drag.track].find(entry => entry.id === drag.itemId);
    const minDur = Math.max(1, Math.min(100, drag.initialEndMs - drag.initialStartMs));
    if (drag.kind === "resize-end") {
      const capBySource = itemObj && "mediaId" in itemObj && !itemObj.loop && drag.sourceDurationMs !== undefined
        ? drag.initialStartMs + Math.max(0, drag.sourceDurationMs - itemObj.sourceInMs)
        : layout.durationMs;
      const maxEnd = Math.min(layout.durationMs, capBySource);
      const minEnd = Math.min(maxEnd, drag.initialStartMs + minDur);
      const rawEnd = drag.initialEndMs + rawDeltaMs;
      const snapped = snapEnabled
        ? snapEdgeMs(rawEnd, targets, snapThresholdMs, minEnd, maxEnd)
        : { ms: Math.round(Math.max(minEnd, Math.min(maxEnd, rawEnd))), snapLineMs: null };
      setDrag({
        ...drag,
        activated: true,
        currentEndMs: snapped.ms,
        deltaMs: snapped.ms - drag.initialEndMs,
        snapLineMs: snapped.snapLineMs,
      });
      return;
    }

    const minStart = itemObj && "mediaId" in itemObj
      ? (itemObj.loop ? 0 : Math.max(0, drag.initialStartMs - itemObj.sourceInMs))
      : 0;
    const maxStart = Math.max(minStart, drag.initialEndMs - minDur);
    const rawStart = drag.initialStartMs + rawDeltaMs;
    const snapped = snapEnabled
      ? snapEdgeMs(rawStart, targets, snapThresholdMs, minStart, maxStart)
      : { ms: Math.round(Math.max(minStart, Math.min(maxStart, rawStart))), snapLineMs: null };
    setDrag({
      ...drag,
      activated: true,
      currentStartMs: snapped.ms,
      deltaMs: snapped.ms - drag.initialStartMs,
      snapLineMs: snapped.snapLineMs,
    });
  };

  const endClipDrag = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    tryRelease(event.currentTarget, event.pointerId);
    const finished = drag;
    setDrag(null);
    if (finished.activated) onInteractingChange?.(false);
    if (!commit || !finished.activated) return;

    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);
    setSelection({ track: finished.track, id: finished.itemId });
    setFormError("");
    if (finished.kind === "move") {
      const res = moveOverlayItem(timeline, finished.track, finished.itemId, finished.currentStartMs, { linkSubtitles });
      update(res.timeline);
      const dir = res.appliedDeltaMs > 0 ? "+" : "";
      if (res.appliedDeltaMs !== 0) {
        setTrackNotice(res.linkedCount > 0
          ? t("已移动 {0}（同步移动 {1} 条字幕）", [`${dir}${roundSec(res.appliedDeltaMs)}s`, res.linkedCount])
          : t("已移动 {0}", [`${dir}${roundSec(res.appliedDeltaMs)}s`]));
      }
      return;
    }
    const edge = finished.kind === "resize-start" ? "start" : "end";
    const targetMs = edge === "start" ? finished.currentStartMs : finished.currentEndMs;
    update(resizeOverlayItem(timeline, finished.track, finished.itemId, edge, targetMs, finished.sourceDurationMs));
  };

  const handleTrackKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      if (drag) {
        setDrag(null);
        onInteractingChange?.(false);
        return;
      }
      if (shiftPanel) { setShiftPanel(null); return; }
      if (selection) { setSelection(undefined); return; }
    }
    if (disabled || !selection || !selectedPlacement) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? 1000 : 100;
      const delta = event.key === "ArrowLeft" ? -step : step;
      applyNudge(selection.track, selection.id, selectedPlacement.startMs + delta);
    }
  };

  const activeShiftBounds = shiftPanel
    ? getTrackShiftBounds(
      timeline,
      shiftPanel.track,
      shiftPanel.scope === "from_selected" && selection?.track === shiftPanel.track ? selection.id : undefined,
    )
    : null;
  const activeShiftLinkedCount = shiftPanel?.track === "voice"
    ? countLinkedSubtitles(timeline)
    : 0;
  const customShiftMs = Math.max(50, Math.round(Number(shiftSeconds) * 1000) || 0);

  return <section className="comic-edit-card comic-multitrack" onKeyDown={handleTrackKeyDown}>
    <header>
      <div className="comic-multitrack-title">
        <h2>{t("工程时间线")}</h2>
        <output>{t("{0} / {1} 秒", [roundSec(playhead), roundSec(layout.durationMs)])}</output>
      </div>
      <div className="comic-actions comic-timeline-toolbar">
        {onUndo && (
          <button type="button" disabled={disabled || !canUndo} onClick={onUndo} title="Ctrl/Cmd+Z">{t("撤销上一步")}</button>
        )}
        {onRedo && (
          <button type="button" disabled={disabled || !canRedo} onClick={onRedo} title="Ctrl/Cmd+Shift+Z">{t("重做")}</button>
        )}
        <button type="button" aria-pressed={snapEnabled} onClick={() => setSnapEnabled(v => !v)}>
          {t("吸附对齐")}
        </button>
        {hasVoiceOrSub && (
          <button type="button" aria-pressed={linkSubtitles} onClick={() => setLinkSubtitles(v => !v)}>
            {t("配音联动字幕")}
          </button>
        )}
        <div className="comic-zoom-group" role="group" aria-label={t("时间线缩放")}>
          <button type="button" aria-label={t("缩小时间线")} disabled={zoomIndex <= 0}
            onClick={() => setZoomIndex(i => Math.max(0, i - 1))}>−</button>
          <span>{zoom}×</span>
          <button type="button" aria-label={t("放大时间线")} disabled={zoomIndex >= zoomLevels.length - 1}
            onClick={() => setZoomIndex(i => Math.min(zoomLevels.length - 1, i + 1))}>+</button>
          {zoom > 1 && (
            <button type="button" onClick={() => {
              setZoomIndex(0);
              if (viewportRef.current) viewportRef.current.scrollLeft = 0;
            }}>{t("适应")}</button>
          )}
        </div>
      </div>
    </header>
    {!!layout.durationMs && (
      <p className="comic-timeline-hint">
        {t("可直接拖动色块调整位置、拖左右边缘调时长；点轨道左侧「平移」可一键整体前移/后移（如配音延后 2 秒），选中后按 ←/→ 微调。")}
      </p>
    )}
    <div className="comic-track-ruler">
      <label>{t("定位播放位置")}<input type="range" min={0} max={total} step={1} value={playhead} disabled={!layout.durationMs}
        onChange={event => seek(Number(event.target.value))} /></label>
      <div aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span key={index}>{t("{0} 秒", [Math.round(total * index / 40) / 100])}</span>)}</div>
    </div>
    <div ref={viewportRef} className="comic-tracks-viewport">
      <div className="comic-tracks-inner" style={zoom > 1 ? { width: `${zoom * 100}%` } : undefined}>
        {!!layout.durationMs && (
          <div className="comic-ruler-bar">
            <div className="comic-track-head comic-ruler-head">
              <span>{t("时间标尺")}</span>
            </div>
            <div className="comic-ruler-track"
              onPointerDown={event => {
                if (event.button !== 0) return;
                tryCapture(event.currentTarget, event.pointerId);
                setScrubbing(true);
                onInteractingChange?.(true);
                seekAtPointer(event.currentTarget, event.clientX);
              }}
              onPointerMove={event => {
                if (!scrubbing) return;
                seekAtPointer(event.currentTarget, event.clientX);
              }}
              onPointerUp={event => {
                if (!scrubbing) return;
                tryRelease(event.currentTarget, event.pointerId);
                setScrubbing(false);
                onInteractingChange?.(false);
              }}
              onPointerCancel={event => {
                if (!scrubbing) return;
                tryRelease(event.currentTarget, event.pointerId);
                setScrubbing(false);
                onInteractingChange?.(false);
              }}>
              {rulerTicks.map(tick => (
                <span key={tick.ms} className="comic-ruler-tick" data-major={tick.major}
                  style={{ insetInlineStart: `${Math.min(98, (tick.ms / total) * 100)}%` }}>
                  {tick.label}
                </span>
              ))}
              <i className="comic-ruler-head-marker" aria-hidden="true"
                style={{ insetInlineStart: `${(playhead / total) * 100}%` }} />
            </div>
          </div>
        )}
        {tracks.map(track => {
          const basePlacements = layout[track];
          const displayPlacements = drag?.activated ? basePlacements.map((entry, idx) => {
            if (track === drag.track && entry.id === drag.itemId) {
              return { ...entry, startMs: drag.currentStartMs, endMs: drag.currentEndMs };
            }
            if (track === "subtitles" && drag.track === "voice" && drag.kind === "move" && drag.linkedSubIds.has(entry.id)) {
              const item = timeline.subtitles[idx];
              const dur = item?.durationMs ?? (entry.endMs - entry.startMs);
              const nextStart = Math.round(Math.max(0, Math.min(Math.max(0, layout.durationMs - dur), entry.startMs + drag.deltaMs)));
              return { ...entry, startMs: nextStart, endMs: nextStart + dur };
            }
            return entry;
          }) : basePlacements;
          const { lanes, rows } = stack(displayPlacements);
          const count = timeline[track].length;
          const shiftOpen = shiftPanel?.track === track;
          return <div key={track} className="comic-track-row">
            <div className="comic-track-head">
              <span>{t(names[track])}</span>
              {track !== "video" && count > 0 && (
                <button type="button" className="comic-track-shift-btn" disabled={disabled}
                  aria-expanded={shiftOpen} aria-label={t("整轨平移 {0}", [t(names[track])])}
                  onClick={() => {
                    setTrackNotice("");
                    setShiftPanel(prev => prev?.track === track ? null : {
                      track,
                      scope: selection?.track === track ? "all" : "all",
                    });
                  }}>
                  {t("平移")}
                </button>
              )}
            </div>
            <div className="comic-track-lane" data-track={track}
              style={{ height: `calc(var(--comic-track-row, 2.25rem) * ${rows})` }}
              onClick={event => {
                if (event.target === event.currentTarget) seekAtPointer(event.currentTarget, event.clientX);
              }}>
              {track !== "video" && cutMarkersMs.map(cutMs => (
                <b key={cutMs} className="comic-cut-marker" aria-hidden="true"
                  style={{ insetInlineStart: `${(cutMs / total) * 100}%` }} />
              ))}
              {lanes.map(({ id, startMs, endMs, index, lane }) => {
                const title = itemTitle(track, index);
                const start = Math.min(99, (startMs / total) * 100);
                const width = Math.min(100 - start, Math.max(0.5, ((endMs - startMs) / total) * 100));
                const pressed = track === "video" ? selectedVideo === id && !selection : selection?.id === id;
                const isDragging = Boolean(drag?.activated && drag.track === track && drag.itemId === id);
                const tip = `${title} (${formatTimelineSec(startMs)} – ${formatTimelineSec(endMs)})`;
                if (track === "video") {
                  return <button key={id} type="button" title={tip}
                    aria-label={t("{0} · {1} 秒", [title, seconds(startMs)])} aria-pressed={pressed}
                    data-overflow={overflow.has(id)}
                    style={{ insetInlineStart: `${start}%`, width: `${width}%`, top: `calc(var(--comic-track-row, 2.25rem) * ${lane} + 3px)` }}
                    onClick={() => choose(track, id, Math.min(startMs, layout.durationMs))}>{title}</button>;
                }
                return <div key={id} className="comic-track-clip" data-dragging={isDragging}
                  style={{ insetInlineStart: `${start}%`, width: `${width}%`, top: `calc(var(--comic-track-row, 2.25rem) * ${lane} + 3px)` }}>
                  <span className="comic-track-handle comic-track-handle-start" aria-hidden="true"
                    onPointerDown={event => beginClipDrag(event, "resize-start", track, id, startMs, endMs)}
                    onPointerMove={moveClipDrag}
                    onPointerUp={event => endClipDrag(event, true)}
                    onPointerCancel={event => endClipDrag(event, false)} />
                  <button type="button" className="comic-track-item" title={tip}
                    aria-label={t("{0} · {1} 秒", [title, seconds(startMs)])} aria-pressed={pressed}
                    data-overflow={overflow.has(id)}
                    onPointerDown={event => beginClipDrag(event, "move", track, id, startMs, endMs)}
                    onPointerMove={moveClipDrag}
                    onPointerUp={event => endClipDrag(event, true)}
                    onPointerCancel={event => endClipDrag(event, false)}
                    onClick={() => {
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      choose(track, id, Math.min(startMs, layout.durationMs));
                    }}>{title}</button>
                  <span className="comic-track-handle comic-track-handle-end" aria-hidden="true"
                    onPointerDown={event => beginClipDrag(event, "resize-end", track, id, startMs, endMs)}
                    onPointerMove={moveClipDrag}
                    onPointerUp={event => endClipDrag(event, true)}
                    onPointerCancel={event => endClipDrag(event, false)} />
                  {isDragging && drag && (
                    <span className="comic-drag-badge" role="status">
                      {drag.kind === "move"
                        ? `${formatTimelineSec(drag.currentStartMs)} – ${formatTimelineSec(drag.currentEndMs)} (${drag.deltaMs >= 0 ? "+" : ""}${roundSec(drag.deltaMs)}s)`
                        : `${t("时长")} ${formatTimelineSec(drag.currentEndMs - drag.currentStartMs)}`}
                    </span>
                  )}
                </div>;
              })}
              {drag?.activated && drag.snapLineMs !== null && (
                <u className="comic-snap-guide" aria-hidden="true"
                  style={{ insetInlineStart: `${(drag.snapLineMs / total) * 100}%` }} />
              )}
              <i aria-hidden="true" style={{ insetInlineStart: `${(playhead / total) * 100}%` }} />
            </div>
          </div>;
        })}
      </div>
    </div>

    {shiftPanel && activeShiftBounds && activeShiftBounds.count > 0 && (
      <div className="comic-track-shift-panel" role="region" aria-label={t("整轨平移 {0}", [t(names[shiftPanel.track])])}>
        <div className="comic-shift-head">
          <div>
            <strong>{t("整轨平移 · {0}", [t(names[shiftPanel.track])])}</strong>
            <small>
              {t("当前 {0} 条（{1} – {2}）· 最多可提前 {3} / 延后 {4}", [
                activeShiftBounds.count,
                formatTimelineSec(activeShiftBounds.minStartMs),
                formatTimelineSec(activeShiftBounds.maxEndMs),
                formatTimelineSec(activeShiftBounds.maxShiftEarlierMs),
                formatTimelineSec(activeShiftBounds.maxShiftLaterMs),
              ])}
            </small>
          </div>
          <button type="button" onClick={() => setShiftPanel(null)}>{t("收起")}</button>
        </div>
        {selection?.track === shiftPanel.track && (
          <div className="comic-actions" role="group" aria-label={t("平移范围")}>
            <button type="button" aria-pressed={shiftPanel.scope === "all"}
              onClick={() => setShiftPanel({ ...shiftPanel, scope: "all" })}>{t("整轨全部")}</button>
            <button type="button" aria-pressed={shiftPanel.scope === "from_selected"}
              onClick={() => setShiftPanel({ ...shiftPanel, scope: "from_selected" })}>{t("当前条及后续")}</button>
          </div>
        )}
        <div className="comic-actions">
          {([-2000, -1000, -500, 500, 1000, 2000] as const).map(delta => {
            const label = delta < 0 ? t("提前 {0} 秒", [-delta / 1000]) : t("延后 {0} 秒", [delta / 1000]);
            const canMove = delta < 0 ? activeShiftBounds.maxShiftEarlierMs > 0 : activeShiftBounds.maxShiftLaterMs > 0;
            return <button key={delta} type="button" disabled={disabled || !canMove}
              onClick={() => applyTrackShift(shiftPanel.track, delta, shiftPanel.scope)}>{label}</button>;
          })}
        </div>
        <div className="comic-actions comic-shift-custom">
          <label>
            {t("平移秒数")}
            <input type="number" min={0.05} max={300} step={0.1} value={shiftSeconds}
              onChange={event => setShiftSeconds(event.target.value)} />
          </label>
          <button type="button" disabled={disabled || !customShiftMs || activeShiftBounds.maxShiftEarlierMs <= 0}
            onClick={() => applyTrackShift(shiftPanel.track, -customShiftMs, shiftPanel.scope)}>
            {t("往前移（提前）")}
          </button>
          <button type="button" className="primary" disabled={disabled || !customShiftMs || activeShiftBounds.maxShiftLaterMs <= 0}
            onClick={() => applyTrackShift(shiftPanel.track, customShiftMs, shiftPanel.scope)}>
            {t("往后移（延后）")}
          </button>
        </div>
        {shiftPanel.track === "voice" && activeShiftLinkedCount > 0 && (
          <label className="comic-track-loop">
            <input type="checkbox" checked={linkSubtitles} onChange={event => setLinkSubtitles(event.target.checked)} />
            {t("同步移动对应字幕（{0} 条）", [activeShiftLinkedCount])}
          </label>
        )}
      </div>
    )}

    {trackNotice && <p className="comic-generation-note" role="status">{trackNotice}</p>}
    {!!overflow.size && (
      <div className="comic-error comic-overflow-banner" role="alert">
        <span>{t("有配音、音乐、音效或字幕超出可用时间，请调整后导出")}</span>
        <button type="button" disabled={disabled} onClick={() => {
          update(fixAllTimelineOverflows(timeline));
          setTrackNotice(t("已自动修复超出范围的轨道条目"));
        }}>{t("一键修复超出项")}</button>
      </div>
    )}
    {!!layout.durationMs && <fieldset className="comic-track-editor" disabled={disabled}>
      <div className="comic-actions">
        <button type="button" onClick={() => setPicker("music")}>{t("添加音乐")}</button>
        <button type="button" onClick={() => setPicker("sfx")}>{t("添加音效")}</button>
        <form className="comic-actions" onSubmit={event => {
          event.preventDefault();
          addSubtitle(new FormData(event.currentTarget));
          event.currentTarget.reset();
        }}>
          <input aria-label={t("字幕文字")} name="text" maxLength={2000} required />
          <button type="submit">{t("在播放头添加字幕")}</button>
        </form>
      </div>
      {picker && <AudioPicker track={picker} choose={material => insertAudio(picker, material)} close={() => setPicker(undefined)} />}
      {selection && selected && selectedPlacement && <div className="comic-track-inspector">
        <div className="comic-inspector-head">
          <div>
            <h3>{t(names[selection.track])}</h3>
            <small>
              {selectedIndex >= 0 ? itemTitle(selection.track, selectedIndex) : ""} ·{" "}
              {formatTimelineSec(selectedPlacement.startMs)} – {formatTimelineSec(selectedPlacement.endMs)} ·{" "}
              {t("时长")} {formatTimelineSec(selected.durationMs)}
            </small>
          </div>
          <span className="comic-pill" data-tone={selected.anchor.kind === "clip" ? "idle" : "done"}>
            {(() => {
              const clipId = selected.anchor.kind === "clip" ? selected.anchor.videoItemId : null;
              return clipId
                ? t("跟随片段 {0}", [Math.max(1, timeline.video.findIndex(v => v.id === clipId) + 1)])
                : t("按工程时间");
            })()}
          </span>
        </div>
        {overflow.has(selected.id) && (
          <div className="comic-error comic-overflow-banner">
            <span>{t("此条目超出了锚点允许的时长")}</span>
            <button type="button" onClick={() => {
              update(fixOverlayOverflow(timeline, selection.track, selected.id));
              setTrackNotice(t("已修复该条目的时间范围"));
            }}>
              {selectedPlacement.startMs + selected.durationMs <= layout.durationMs
                ? t("改为跨片段定位")
                : t("自动适配总时长")}
            </button>
          </div>
        )}
        <div className="comic-quick-nudge" role="group" aria-label={t("快速微调位置")}>
          {([-2000, -1000, -500, -100, 100, 500, 1000, 2000] as const).map(delta => (
            <button key={delta} type="button"
              onClick={() => applyNudge(selection.track, selected.id, selectedPlacement.startMs + delta)}>
              {delta > 0 ? `+${delta / 1000}s` : `${delta / 1000}s`}
            </button>
          ))}
          <button type="button" onClick={() => applyNudge(selection.track, selected.id, playhead)}>
            {t("对齐播放头")}
          </button>
          <button type="button" onClick={() => setShiftPanel({ track: selection.track, scope: "all" })}>
            {t("平移此轨")}
          </button>
        </div>
        {formError && <p className="comic-error" role="alert">{t(formError)}</p>}
        <OverlayFields key={JSON.stringify(selected)} item={selected} video={timeline.video} layoutVideo={layout.video}
          apply={replace} remove={() => {
            update({ ...timeline, [selection.track]: timeline[selection.track].filter(item => item.id !== selected.id) });
            setSelection(undefined);
          }} />
        {selectedAudio && length && <MediaPreview key={selectedAudio.mediaId}
          media={{ id: selectedAudio.mediaId, hasThumbnail: false, durationMs: length }} title={t("试听源音频")} />}
      </div>}
      {!!timeline.subtitles.length && <CaptionStyleFields timeline={timeline} change={captionStyle => update({ ...timeline, captionStyle })} />}
    </fieldset>}
  </section>;
}

function OverlayFields({ item, video, layoutVideo, apply, remove }: {
  item: Audio | Subtitle; video: ComicTimeline["video"];
  layoutVideo: ReturnType<typeof layoutComicTimeline>["video"];
  apply: (item: Audio | Subtitle) => void; remove: () => void;
}) {
  const { t } = useI18n();
  const isAudio = "mediaId" in item;
  const [anchorVal, setAnchorVal] = useState<string>(item.anchor.kind === "clip" ? item.anchor.videoItemId : "timeline");
  const [offsetText, setOffsetText] = useState<string>(String(seconds(item.anchor.offsetMs)));

  const handleAnchorChange = (nextAnchor: string) => {
    const clipStart = (id: string) => layoutVideo.find(entry => entry.id === id)?.startMs ?? 0;
    const currentOffsetMs = Math.round((Number(offsetText) || 0) * 1000);
    const absStartMs = anchorVal === "timeline" ? currentOffsetMs : clipStart(anchorVal) + currentOffsetMs;
    const nextOffsetMs = nextAnchor === "timeline"
      ? Math.max(0, absStartMs)
      : Math.max(0, absStartMs - clipStart(nextAnchor));
    setAnchorVal(nextAnchor);
    setOffsetText(String(Number((nextOffsetMs / 1000).toFixed(3))));
  };

  return <form className="comic-overlay-fields" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const common = { anchor: position(form), durationMs: ms(form, "duration") };
    apply(isAudio ? {
      ...item, ...common, sourceInMs: ms(form, "source"), volume: Number(form.get("volume")) / 100,
      fadeInMs: ms(form, "fadeIn"), fadeOutMs: ms(form, "fadeOut"), loop: form.get("loop") === "on",
    } : { ...item, ...common, text: String(form.get("text") ?? "") });
  }}>
    <label>{t("时间锚点")}<select name="anchor" aria-label={t("时间锚点")} value={anchorVal}
      onChange={event => handleAnchorChange(event.target.value)}>
      <option value="timeline">{t("工程起点")}</option>
      {video.map((clip, index) => <option key={clip.id} value={clip.id}>{t("片段 {0}", [index + 1])}</option>)}
    </select></label>
    <label>{t("偏移（秒）")}<input type="number" name="offset" min={0} max={300} step={0.001} required
      value={offsetText} onChange={event => setOffsetText(event.target.value)} /></label>
    <TimeField label={t("时长（秒）")} name="duration" value={item.durationMs} min={0.001} />
    {isAudio ? <>
      <TimeField label={t("音频入点（秒）")} name="source" value={item.sourceInMs} />
      <TimeField label={t("淡入（秒）")} name="fadeIn" value={item.fadeInMs} />
      <TimeField label={t("淡出（秒）")} name="fadeOut" value={item.fadeOutMs} />
      <label>{t("音量（%）")}<input name="volume" type="number" min={0} max={200} required defaultValue={Math.round(item.volume * 100)} /></label>
      <label className="comic-track-loop"><input type="checkbox" name="loop" defaultChecked={item.loop} />{t("循环")}</label>
    </> : <label>{t("字幕文字")}<textarea aria-label={t("字幕文字")} name="text" required maxLength={2000} defaultValue={item.text} /></label>}
    <div className="comic-actions"><button type="submit">{t("应用轨道设置")}</button><button type="button" onClick={remove}>{t("移除")}</button></div>
  </form>;
}

function TimeField({ label, name, value, min = 0 }: { label: string; name: string; value: number; min?: number }) {
  return <label>{label}<input type="number" name={name} min={min} max={300} step={0.001} required defaultValue={seconds(value)} /></label>;
}

function AudioPicker({ track, choose, close }: { track: "music" | "sfx"; choose: (material: ComicMaterial) => void; close: () => void }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ComicLibraryPage<ComicMaterial> | "error" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    void comicLibraryApi.materials({ kind: track === "music" ? "music" : "sound", query: search, page: String(page) }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setState(value); })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [track, search, page]);
  return <div className="comic-track-picker">
    <div className="comic-actions">
      <label>{t("搜索音频素材")}<input value={search} maxLength={120} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <button type="button" onClick={close}>{t("取消")}</button>
    </div>
    {state === null ? <p role="status">{t("加载中…")}</p> : state === "error" ? <p role="alert">{t("操作失败，请重试")}</p> : <>
      {state.entries.length ? <ul>{state.entries.map(material => <li key={material.id}>
        <span>{material.name} · {t("{0} 秒", [seconds(material.media.durationMs ?? 0)])}</span>
        <button type="button" disabled={!material.media.durationMs} onClick={() => choose(material)}>{t("添加到轨道")}</button>
      </li>)}</ul> : <p>{t("素材库暂无此类音频")}</p>}
      <div className="comic-actions">
        <button type="button" disabled={page < 2} onClick={() => setPage(value => value - 1)}>{t("上一页")}</button>
        <button type="button" disabled={!state.more} onClick={() => setPage(value => value + 1)}>{t("下一页")}</button>
      </div>
    </>}
  </div>;
}

function CaptionStyleFields({ timeline, change }: {
  timeline: ComicTimeline; change: (style: NonNullable<ComicTimeline["captionStyle"]>) => void;
}) {
  const { t } = useI18n();
  const style = timeline.captionStyle ?? { size: "medium", position: "medium", color: "white" };
  return <div className="comic-caption-style">
    <label>{t("字幕字号")}<select value={style.size} onChange={e => change({ ...style, size: e.target.value as typeof style.size })}>
      <option value="small">{t("小")}</option><option value="medium">{t("中")}</option><option value="large">{t("大")}</option>
    </select></label>
    <label>{t("字幕位置")}<select value={style.position} onChange={e => change({ ...style, position: e.target.value as typeof style.position })}>
      <option value="low">{t("底部")}</option><option value="medium">{t("稍高")}</option><option value="high">{t("上移")}</option>
    </select></label>
    <label>{t("字幕颜色")}<select value={style.color} onChange={e => change({ ...style, color: e.target.value as typeof style.color })}>
      <option value="white">{t("白色")}</option><option value="yellow">{t("黄色")}</option><option value="black">{t("黑色")}</option>
      <option value="box">{t("白字底框")}</option><option value="yellow-box">{t("黄字底框")}</option>
    </select></label>
  </div>;
}
