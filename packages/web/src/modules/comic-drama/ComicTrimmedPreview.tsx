import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  layoutComicTimeline, type ComicEditAudioSource, type ComicEditSource, type ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import {
  computeOverlayAudioStates, effectiveVideoAudioState, type PreviewAudioTrack, type PreviewTrackToggles,
} from "./preview-audio.js";

export function ComicTrimmedPreview({ timeline, sources, audioSources = [], seek, position, onPosition }: {
  timeline: ComicTimeline;
  sources: ComicEditSource[];
  audioSources?: readonly ComicEditAudioSource[];
  seek: { ms: number };
  position: number;
  onPosition: (ms: number) => void;
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
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
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
    const missing = audioMediaIds.filter(id => !audioUrls[id]);
    if (!missing.length) return;
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
    return () => controller.abort();
  }, [audioMediaIds, audioUrls]);

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

  return <section className="comic-edit-card comic-timeline-preview">
    <header>
      <h2>{t("剪辑预览")}</h2>
      {videoAudio?.muted && <small className="comic-pill" data-tone="idle">{t("片段原声已静音")}</small>}
    </header>
    {items.length === 0 ? <p className="comic-generation-note">{t("添加片源后即可预览")}</p> :
      failed ? <button onClick={() => setRetry(value => value + 1)}>{t("重新获取预览")}</button> : <>
        <div className="comic-timeline-player" style={{ aspectRatio: timeline.aspectRatio.replace(":", "/") }}>
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
          <button type="button" disabled={!index} onClick={() => locate(index - 1, layout.video[index - 1].startMs, false)}>{t("上一片段")}</button>
          <small>{t("片段 {0} / {1}", [index + 1, items.length])}</small>
          <button type="button" disabled={index + 1 >= items.length} onClick={() => locate(index + 1, layout.video[index + 1].startMs, false)}>
            {t("下一片段")}
          </button>
        </div>
      </>}
  </section>;
}
