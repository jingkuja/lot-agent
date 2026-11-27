import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  layoutComicTimeline, type ComicEditAudioSource, type ComicEditSource, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import {
  computeOverlayAudioStates, effectiveVideoAudioState, type PreviewAudioTrack, type PreviewTrackToggles,
} from "./preview-audio.js";

function parseAspectRatio(ratio: string): {
  css: string;
  value: number;
  orientation: "landscape" | "portrait" | "square";
} {
  const parts = ratio.split(":").map(Number);
  const w = parts[0] && Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 9;
  const h = parts[1] && Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 16;
  const value = w / h;
  const orientation = value > 1.05 ? "landscape" : value < 0.95 ? "portrait" : "square";
  return { css: `${w} / ${h}`, value, orientation };
}

export function ComicTrimmedPreview({
  timeline,
  sources,
  audioSources = [],
  seek,
  position,
  onPosition,
  onSelectVideo,
  collapsed,
  onToggleCollapse,
}: {
  timeline: ComicTimeline;
  sources: ComicEditSource[];
  audioSources?: readonly ComicEditAudioSource[];
  seek: { ms: number };
  position: number;
  onPosition: (ms: number) => void;
  onSelectVideo?: (videoItemId: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const items = timeline.video;
  const layout = useMemo(() => layoutComicTimeline(timeline), [timeline]);
  const [index, setIndex] = useState(0);
  const item = items[index];
  const source = sources.find(source => source.takeId === item?.takeId);
  const playerRef = useRef<HTMLVideoElement>(null);
  const lastSeek = useRef(seek);
  const requested = useRef<number | null>(null);
  const continuePlaying = useRef(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trackEnabled, setTrackEnabled] = useState<PreviewTrackToggles>({
    video: true, voice: true, sfx: true, music: true,
  });
  const [expanded, setExpanded] = useState(false);
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const isCollapsed = collapsed ?? localCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setLocalCollapsed(v => !v));
  const aspect = useMemo(() => parseAspectRatio(timeline.aspectRatio), [timeline.aspectRatio]);
  useEffect(() => {
    if (!isCollapsed) return;
    setExpanded(false);
    const player = playerRef.current;
    if (player && !player.paused) player.pause();
    continuePlaying.current = false;
    setPlaying(false);
  }, [isCollapsed]);
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);
  useEffect(() => {
    if (!items.length && expanded) setExpanded(false);
  }, [expanded, items.length]);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const audioLinkRequestedRef = useRef<Set<string>>(new Set());
  const audioPoolRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const videoGainRef = useRef<{ element: HTMLVideoElement; gain: GainNode } | null>(null);
  const ready = useRef(false);

  const audioMediaIds = useMemo(() => [...new Set([
    ...timeline.voice.map(entry => entry.mediaId),
    ...timeline.sfx.map(entry => entry.mediaId),
    ...timeline.music.map(entry => entry.mediaId),
  ])], [timeline.music, timeline.sfx, timeline.voice]);

  useEffect(() => {
    const missing = audioMediaIds.filter(id => !audioLinkRequestedRef.current.has(id));
    if (!missing.length) return;
    for (const id of missing) audioLinkRequestedRef.current.add(id);
    const controller = new AbortController();
    void Promise.allSettled(missing.map(async id => {
      const links = await comicLibraryApi.links(id, controller.signal);
      return [id, links.url] as const;
    })).then(results => {
      if (controller.signal.aborted) return;
      const patch: Record<string, string> = {};
      for (const res of results) {
        if (res.status === "fulfilled") patch[res.value[0]] = res.value[1];
      }
      if (Object.keys(patch).length) setAudioUrls(prev => ({ ...prev, ...patch }));
    });
    return () => {
      controller.abort();
      if (controller.signal.aborted) {
        for (const id of missing) audioLinkRequestedRef.current.delete(id);
      }
    };
  }, [audioMediaIds]);

  useEffect(() => {
    const pool = audioPoolRef.current;
    return () => {
      for (const el of pool.values()) {
        el.pause();
        el.src = "";
      }
      pool.clear();
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      videoGainRef.current = null;
    };
  }, []);

  const applyVideoVolume = useCallback((player: HTMLVideoElement | null) => {
    if (!player || !item) return;
    const state = effectiveVideoAudioState(item.volume, trackEnabled.video);
    player.muted = state.muted;
    if (state.gain > 1 && typeof window !== "undefined" && typeof window.AudioContext === "function") {
      try {
        if (!audioCtxRef.current) audioCtxRef.current = new window.AudioContext();
        const ctx = audioCtxRef.current;
        if (videoGainRef.current?.element !== player) {
          const mediaSource = ctx.createMediaElementSource(player);
          const gainNode = ctx.createGain();
          mediaSource.connect(gainNode);
          gainNode.connect(ctx.destination);
          videoGainRef.current = { element: player, gain: gainNode };
        }
        videoGainRef.current.gain.gain.value = state.gain;
        player.volume = 1;
        if (ctx.state === "suspended") void ctx.resume().catch(() => {});
        return;
      } catch {
        // Fallback to standard element volume when Web Audio API is unavailable
      }
    }
    if (videoGainRef.current?.element === player) {
      videoGainRef.current.gain.gain.value = 1;
    }
    player.volume = state.elementVolume;
  }, [item, trackEnabled.video]);

  useEffect(() => {
    applyVideoVolume(playerRef.current);
  }, [applyVideoVolume, url]);

  const syncOverlayAudio = useCallback((posMs: number, isPlaying: boolean) => {
    const pool = audioPoolRef.current;
    const activeStates = computeOverlayAudioStates(timeline, layout, audioSources, posMs, trackEnabled);
    const activeKeys = new Set<string>();
    for (const entry of activeStates) {
      const src = audioUrls[entry.mediaId];
      if (!src) continue;
      activeKeys.add(entry.key);
      let el = pool.get(entry.key);
      if (!el) {
        el = new Audio(src);
        el.preload = "auto";
        pool.set(entry.key, el);
      } else if (el.src !== src && !el.src.endsWith(src)) {
        el.src = src;
      }
      el.muted = entry.elementVolume <= 0;
      el.volume = entry.elementVolume;
      const targetSec = entry.sourceTimeMs / 1000;
      if (Number.isFinite(targetSec) && Math.abs(el.currentTime - targetSec) > 0.18) {
        try { el.currentTime = targetSec; } catch { /* wait for metadata */ }
      }
      if (isPlaying) {
        if (el.paused) void el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    }
    for (const [key, el] of pool.entries()) {
      if (!activeKeys.has(key) && !el.paused) el.pause();
    }
  }, [audioSources, audioUrls, layout, timeline, trackEnabled]);

  useEffect(() => {
    syncOverlayAudio(position, playing);
  }, [playing, position, syncOverlayAudio]);

  useEffect(() => {
    const controller = new AbortController();
    ready.current = false;
    setUrl(null);
    setFailed(false);
    if (!source) return;
    void comicLibraryApi.links(source.mediaId, controller.signal).then(value => {
      if (!controller.signal.aborted) setUrl(value.url);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [index, item?.id, item?.inMs, item?.outMs, source?.mediaId, retry]);
  useEffect(() => {
    if (index >= items.length) { setIndex(0); continuePlaying.current = false; setPlaying(false); }
  }, [index, items.length]);
  const locate = (next: number, ms: number, keepPlaying: boolean) => {
    const clip = items[next];
    if (!clip) return;
    const inputMs = Math.max(clip.inMs, Math.min(clip.outMs - 1, clip.inMs + ms - layout.video[next].startMs));
    const player = playerRef.current;
    if (next === index && player && ready.current) player.currentTime = inputMs / 1000;
    else {
      requested.current = inputMs;
      continuePlaying.current = keepPlaying && !!player && !player.paused;
      ready.current = false;
      setIndex(next);
    }
    onPosition(ms);
  };
  useEffect(() => {
    if (lastSeek.current === seek) return;
    lastSeek.current = seek;
    let next = 0;
    for (const [candidate, clip] of layout.video.entries()) if (clip.startMs <= seek.ms) next = candidate;
    locate(next, Math.min(seek.ms, layout.durationMs), true);
  });
  const advance = (player: HTMLVideoElement) => {
    if (!ready.current || !item) return;
    const current = layout.video[index];
    const next = layout.video[index + 1];
    const start = item.inMs / 1000, end = (item.inMs + (next?.startMs ?? current.endMs) - current.startMs) / 1000;
    if (player.currentTime < start) { player.currentTime = start; return; }
    const nextPos = Math.min(current.endMs, Math.max(current.startMs, Math.round(current.startMs + player.currentTime * 1000 - item.inMs)));
    onPosition(nextPos);
    syncOverlayAudio(nextPos, !player.paused && !player.ended);
    if (player.paused && !player.ended) return;
    if (player.currentTime + 0.015 < end) return;
    ready.current = false;
    continuePlaying.current = !player.paused || player.ended;
    if (index + 1 < items.length) {
      requested.current = null;
      player.pause();
      onPosition(next.startMs);
      setIndex(index + 1);
    } else {
      player.pause();
      player.currentTime = Math.min(end, player.duration);
      continuePlaying.current = false;
      setPlaying(false);
    }
  };
  const activeCaption = layout.subtitles.findIndex(cue => cue.startMs <= position && cue.endMs > position);
  const activeAudio = useMemo(
    () => computeOverlayAudioStates(timeline, layout, audioSources, position, trackEnabled),
    [audioSources, layout, position, timeline, trackEnabled],
  );
  const videoAudio = item ? effectiveVideoAudioState(item.volume, trackEnabled.video) : null;
  const toggleTrack = (key: keyof PreviewTrackToggles) => setTrackEnabled(prev => ({ ...prev, [key]: !prev[key] }));
  const trackLabel = (track: PreviewAudioTrack) => track === "voice" ? "对白" : track === "sfx" ? "音效" : "配乐";

  return <section
    className={`comic-edit-card comic-timeline-preview${isCollapsed ? " is-collapsed" : ""}`}
    onClick={isCollapsed ? toggleCollapse : undefined}
  >
    {expanded && (
      <div className="comic-preview-placeholder">
        <span>{t("正在放大预览中…")}</span>
        <button type="button" onClick={() => setExpanded(false)}>{t("退出放大")}</button>
      </div>
    )}
    <div
      className={`comic-preview-shell${expanded ? " is-expanded" : ""}`}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? t("放大预览") : undefined}
      onClick={expanded ? event => { if (event.target === event.currentTarget) setExpanded(false); } : undefined}
    >
      <div className="comic-preview-panel" data-orientation={aspect.orientation}>
        <header className="comic-stage-card-header">
          <div className="comic-stage-card-header-main">
            <div className="comic-preview-title-group">
              <h2>{t("剪辑预览")}</h2>
              <small className="comic-pill" data-tone="idle">{timeline.aspectRatio}</small>
              {videoAudio?.muted && <small className="comic-pill" data-tone="idle">{t("片段原声已静音")}</small>}
            </div>
            {!isCollapsed && items.length > 0 && !failed && (
              <button type="button" className="comic-preview-expand-btn" onClick={() => setExpanded(v => !v)}>
                {t(expanded ? "收起预览" : "放大预览")}
              </button>
            )}
          </div>
          {!expanded && (
            <button
              type="button"
              className="comic-stage-collapse-btn"
              aria-expanded={!isCollapsed}
              aria-label={t(isCollapsed ? "展开剪辑预览" : "收起剪辑预览")}
              title={t(isCollapsed ? "展开剪辑预览" : "收起剪辑预览")}
              onClick={event => {
                event.stopPropagation();
                toggleCollapse();
              }}
            >
              <span className="comic-stage-collapse-icon" aria-hidden="true">{isCollapsed ? "»" : "«"}</span>
              <span className="comic-stage-collapse-label">{t(isCollapsed ? "展开" : "收起")}</span>
            </button>
          )}
        </header>
        <div className="comic-stage-card-body" hidden={isCollapsed}>
          {items.length === 0 ? <p className="comic-generation-note">{t("添加片源后即可预览")}</p> :
            failed ? <button onClick={() => setRetry(value => value + 1)}>{t("重新获取预览")}</button> : <>
              <div
                className="comic-timeline-stage"
                data-orientation={aspect.orientation}
                onClick={!expanded ? event => { if (event.target === event.currentTarget) setExpanded(true); } : undefined}
              >
                <div className="comic-timeline-player" style={{ aspectRatio: aspect.css }}>
                  {url && item ? <video ref={playerRef} key={item.id + url} src={url} controls playsInline preload="metadata" aria-label={t("剪辑预览")}
                    onLoadedMetadata={event => {
                      const player = event.currentTarget;
                      applyVideoVolume(player);
                      const ms = requested.current ?? item.inMs;
                      requested.current = null;
                      if (ms > 0) player.currentTime = ms / 1000;
                      ready.current = true;
                      if (continuePlaying.current) void player.play().catch(() => {});
                    }} onTimeUpdate={event => advance(event.currentTarget)} onEnded={event => advance(event.currentTarget)}
                    onPlay={event => {
                      applyVideoVolume(event.currentTarget);
                      if (event.currentTarget.currentTime >= item.outMs / 1000) event.currentTarget.currentTime = item.inMs / 1000;
                      ready.current = true;
                      setPlaying(true);
                    }}
                    onPause={() => { if (!continuePlaying.current) setPlaying(false); }}
                    onError={() => setFailed(true)} /> : <span role="status">{t("加载中…")}</span>}
                  {item && activeCaption >= 0 && <span className="comic-preview-caption" data-position={timeline.captionStyle?.position}
                    data-size={timeline.captionStyle?.size} data-color={timeline.captionStyle?.color}>{timeline.subtitles[activeCaption].text}</span>}
                </div>
                {!expanded && (
                  <button
                    type="button"
                    className="comic-preview-zoom-fab"
                    aria-label={t("放大视频画面")}
                    title={t("点击放大预览")}
                    onClick={() => setExpanded(true)}
                  >
                    ⤢
                  </button>
                )}
              </div>
              <div className="comic-actions comic-preview-tracks" role="group" aria-label={t("试听轨道")}>
                <button type="button" aria-pressed={trackEnabled.video} onClick={() => toggleTrack("video")}>
                  {t("原声")}{item ? ` (${Math.round(item.volume * 100)}%)` : ""}
                </button>
                <button type="button" aria-pressed={trackEnabled.voice} onClick={() => toggleTrack("voice")}>
                  {t("对白")} ({timeline.voice.length})
                </button>
                <button type="button" aria-pressed={trackEnabled.sfx} onClick={() => toggleTrack("sfx")}>
                  {t("音效")} ({timeline.sfx.length})
                </button>
                <button type="button" aria-pressed={trackEnabled.music} onClick={() => toggleTrack("music")}>
                  {t("配乐")} ({timeline.music.length})
                </button>
              </div>
              {activeAudio.length > 0 && (
                <div className="comic-preview-cues" role="status">
                  <small>{t("当前时间点激活音轨：")}</small>
                  {activeAudio.map(entry => (
                    <small key={entry.key} className="comic-pill" data-tone="done">
                      {t(trackLabel(entry.track))} · {Math.round(entry.gain * 100)}%
                    </small>
                  ))}
                </div>
              )}
              <div className="comic-actions">
                <button type="button" disabled={!index} onClick={() => {
                  const prev = index - 1;
                  locate(prev, layout.video[prev].startMs, false);
                  onSelectVideo?.(items[prev].id);
                }}>{t("上一片段")}</button>
                <small>{t("片段 {0} / {1}", [index + 1, items.length])}</small>
                <button type="button" disabled={index + 1 >= items.length} onClick={() => {
                  const next = index + 1;
                  locate(next, layout.video[next].startMs, false);
                  onSelectVideo?.(items[next].id);
                }}>
                  {t("下一片段")}
                </button>
              </div>
            </>}
        </div>
      </div>
    </div>
  </section>;
}
