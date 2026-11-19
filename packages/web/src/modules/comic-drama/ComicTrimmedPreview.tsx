import { useEffect, useRef, useState } from "react";
import { layoutComicTimeline, type ComicEditSource, type ComicTimeline } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";

export function ComicTrimmedPreview({ timeline, sources, seek, position, onPosition }: {
  timeline: ComicTimeline; sources: ComicEditSource[]; seek: { ms: number }; position: number; onPosition: (ms: number) => void;
}) {
  const { t } = useI18n();
  const items = timeline.video;
  const layout = layoutComicTimeline(timeline);
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
  const ready = useRef(false);
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
    if (index >= items.length) { setIndex(0); continuePlaying.current = false; }
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
    onPosition(Math.min(current.endMs, Math.max(current.startMs, Math.round(current.startMs + player.currentTime * 1000 - item.inMs))));
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
    }
  };
  const activeCaption = layout.subtitles.findIndex(cue => cue.startMs <= position && cue.endMs > position);
  return <section className="comic-edit-card comic-timeline-preview">
    <header><h2>{t("剪辑预览")}</h2></header>
    {items.length === 0 ? <p className="comic-generation-note">{t("添加片源后即可预览")}</p> :
      failed ? <button onClick={() => setRetry(value => value + 1)}>{t("重新获取预览")}</button> : <>
        <div className="comic-timeline-player" style={{ aspectRatio: timeline.aspectRatio.replace(":", "/") }}>
          {url && item ? <video ref={playerRef} key={item.id + url} src={url} controls playsInline preload="metadata" aria-label={t("剪辑预览")}
            onLoadedMetadata={event => {
              const player = event.currentTarget;
              const ms = requested.current ?? item.inMs;
              requested.current = null;
              if (ms > 0) player.currentTime = ms / 1000;
              ready.current = true;
              if (continuePlaying.current) void player.play().catch(() => {});
            }} onTimeUpdate={event => advance(event.currentTarget)} onEnded={event => advance(event.currentTarget)}
            onPlay={event => {
              if (event.currentTarget.currentTime >= item.outMs / 1000) event.currentTarget.currentTime = item.inMs / 1000;
              ready.current = true;
            }} onError={() => setFailed(true)} /> : <span role="status">{t("加载中…")}</span>}
          {item && activeCaption >= 0 && <span className="comic-preview-caption" data-position={timeline.captionStyle?.position}
            data-size={timeline.captionStyle?.size} data-color={timeline.captionStyle?.color}>{timeline.subtitles[activeCaption].text}</span>}
        </div>
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
