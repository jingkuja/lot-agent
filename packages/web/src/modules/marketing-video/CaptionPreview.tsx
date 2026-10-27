import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { captionLayout, marketingCaptionsValue, marketingFrameSize, marketingPreviewCaptions, type MarketingDraft,
  type MarketingProject } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";

/** Lets the caption settings play one shot of the video. */
export interface ResultPlayer { playShot(index: number): void }

/** Whether the draft's captions differ from the ones the video was composed with. */
export const captionsChanged = (draft: MarketingDraft, rendered: MarketingDraft) => draft.subtitles !== rendered.subtitles
  || JSON.stringify(marketingCaptionsValue(draft.captions)) !== JSON.stringify(marketingCaptionsValue(rendered.captions));

/** The made video. When it was composed with a caption-free copy (M08), caption changes are watched on that
 * copy with the draft's captions drawn over it, timed like the composition would time them, before
 * composing again. */
export function ResultVideo({ url, output, draft, rendered, player }: {
  url: string; output: NonNullable<MarketingProject["output"]>; draft: MarketingDraft;
  /** The draft the video was composed from; absent when its captions cannot be changed. */
  rendered?: MarketingDraft;
  player: Ref<ResultPlayer>;
}) {
  const { t, locale } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const available = !!rendered && !!output.preview && !!output.captionTiming?.length;
  const changed = available && captionsChanged(draft, rendered);
  const [previewing, setPreviewing] = useState(false);
  // A caption change shows its preview at once; the made video stays one click away.
  useEffect(() => { if (changed) setPreviewing(true); }, [changed]);
  const preview = available && previewing;
  const timing = output.captionTiming ?? [];
  const cues = preview && draft.subtitles ? marketingPreviewCaptions(draft, timing) : { captions: [], changed: [] };
  const time = usePlaybackTime(video);
  const line = cues.captions.find(cue => time >= cue.start && time < cue.end)?.text;
  const box = useVideoBox(video, marketingFrameSize(rendered ?? draft));
  // Switching between the two files keeps the position and whether it was playing.
  const resume = useRef<{ at: number; playing: boolean } | null>(null);
  const choose = (next: boolean) => {
    if (next === previewing || !video.current) return;
    resume.current = { at: video.current.currentTime, playing: !video.current.paused };
    setPreviewing(next);
  };
  useImperativeHandle(player, () => ({
    playShot(index: number) {
      const element = video.current;
      if (!element) return;
      element.currentTime = timing.slice(0, index).reduce((sum, shot) => sum + shot.durationSec, 0)
        || (rendered ?? draft).storyboard.slice(0, index).reduce((sum, shot) => sum + shot.durationSec, 0);
      element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      void element.play().catch(() => {});
    },
  }), [timing, rendered, draft]);
  const layout = box && captionLayout(box.frame.width, box.frame.height, draft.captions);
  const shotList = (slots: number[]) => slots.map(index => index + 1).join(locale === "zh" ? "、" : ", ");
  return <div className="mv-result-player">
    <div className="mv-result-frame">
      <video ref={video} className="mv-result-video" controls src={preview ? output.preview!.url : url} onLoadedMetadata={e => {
        const state = resume.current; resume.current = null;
        if (!state) return;
        e.currentTarget.currentTime = state.at;
        if (state.playing) void e.currentTarget.play().catch(() => {});
      }} />
      {preview && box && layout && <div className="mv-caption-overlay" aria-hidden="true"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
        <span className="mv-caption-badge">{t("预览：未重新合成")}</span>
        {line && <p style={{ bottom: layout.marginV * box.scale, fontSize: layout.fontSize * box.scale, paddingInline: box.frame.width * 0.06 * box.scale,
          WebkitTextStrokeWidth: Math.max(2, Math.round(layout.fontSize * 0.08)) * 2 * box.scale }}>{line}</p>}
      </div>}
    </div>
    {available && <>
      <div className="mv-preview-modes" role="group" aria-label={t("字幕预览")}>
        <button type="button" className={preview ? "" : "selected"} aria-pressed={!preview} onClick={() => choose(false)}>{t("原成片")}</button>
        <button type="button" className={preview ? "selected" : ""} aria-pressed={preview} onClick={() => choose(true)}>{t("预览字幕修改")}</button>
      </div>
      {preview && <p className="mv-hint" role="status">{t("预览只在页面上叠加字幕，与成片的字体渲染可能略有差别。满意后点击「重新合成成片」。")}
        {!!cues.changed.length && ` ${t("第 {0} 镜口播已修改，重新合成后才能预览该镜字幕。", [shotList(cues.changed)])}`}</p>}
    </>}
  </div>;
}

/** The video's current time while it plays, read each frame so captions change on time. */
function usePlaybackTime(video: RefObject<HTMLVideoElement | null>) {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let frame = 0;
    const read = () => setTime(element.currentTime);
    const tick = () => { read(); if (!element.paused && !element.ended) frame = requestAnimationFrame(tick); };
    const play = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); };
    const events = ["play", "seeked", "timeupdate", "loadedmetadata"] as const;
    element.addEventListener("play", play);
    for (const name of events.slice(1)) element.addEventListener(name, read);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("play", play);
      for (const name of events.slice(1)) element.removeEventListener(name, read);
    };
  }, []);
  return time;
}

/** Where the picture sits inside the video element (it is letterboxed to fit), and its scale to the composed frame. */
function useVideoBox(video: RefObject<HTMLVideoElement | null>, frame: { width: number; height: number }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = video.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  if (!size?.width || !size.height) return null;
  const scale = Math.min(size.width / frame.width, size.height / frame.height);
  const width = frame.width * scale, height = frame.height * scale;
  return { frame, scale, width, height, left: (size.width - width) / 2, top: (size.height - height) / 2 };
}
