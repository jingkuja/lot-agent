import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { captionLayout, marketingCaptionsValue, marketingFrameSize, marketingPreviewCaptions, type MarketingCaption, type MarketingDraft,
  type MarketingProject } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";

/** Lets the caption settings play one shot of the video, or switch it between the made video and the caption preview;
 * `reveal` (default true) scrolls the video into view and focuses it. */
export interface ResultPlayer { playShot(index: number): void; showPreview(preview: boolean, reveal?: boolean): void }

type CaptionTiming = NonNullable<NonNullable<MarketingProject["output"]>["captionTiming"]>;
/** Composing a preview video is held back for now; a preview made before still offers its keep or discard choice. */
const PREVIEW_VIDEO = false;
const NO_TIMING: CaptionTiming = [];

/** Whether the draft's captions differ from the ones the video was composed with. */
export const captionsChanged = (draft: MarketingDraft, rendered: MarketingDraft) => draft.subtitles !== rendered.subtitles
  || JSON.stringify(marketingCaptionsValue(draft.captions)) !== JSON.stringify(marketingCaptionsValue(rendered.captions));

/** The draft's captions timed like the composition would time them; worked out once per caption change, not per frame. */
const usePreviewCaptions = (on: boolean, draft: MarketingDraft, timing: CaptionTiming) =>
  useMemo(() => on && draft.subtitles ? marketingPreviewCaptions(draft, timing) : { captions: [], changed: [] }, [on, draft, timing]);

/** The made video. When it was composed with a caption-free copy (M08), caption changes are watched on that
 * copy with the draft's captions drawn over it, timed like the composition would time them, before
 * composing again. The live preview plays in `slot`, beside the caption settings, so one player serves both. */
export function ResultVideo({ url, previewUrl, output, draft, rendered, player, previewing, onPreview, slot }: {
  url: string; output: NonNullable<MarketingProject["output"]>; draft: MarketingDraft;
  /** The caption-free copy's link, kept across responses like `url`. */
  previewUrl?: string;
  /** The draft the video was composed from; absent when its captions cannot be changed. */
  rendered?: MarketingDraft;
  player: Ref<ResultPlayer>;
  /** Whether the caption preview is chosen; the choice is made in the caption settings with `CaptionPreviewModes`. */
  previewing: boolean; onPreview(preview: boolean): void;
  /** Where the live preview plays, in the caption settings; without it the preview plays here. */
  slot?: HTMLElement | null;
}) {
  const { t } = useI18n();
  // Moving between this place and `slot` makes a new element; the hooks follow it.
  const video = useRef<HTMLVideoElement | null>(null);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const attach = useCallback((node: HTMLVideoElement | null) => { video.current = node; setElement(node); }, []);
  const available = !!rendered && !!previewUrl && !!output.captionTiming?.length;
  const changed = available && captionsChanged(draft, rendered);
  // A caption change shows its preview at once; the made video stays one click away.
  useEffect(() => { if (changed) onPreview(true); }, [changed]);
  const preview = available && previewing;
  const timing = output.captionTiming ?? NO_TIMING;
  const { captions } = usePreviewCaptions(preview, draft, timing);
  const line = useCaptionLine(element, captions);
  const box = useVideoBox(element, marketingFrameSize(rendered ?? draft));
  // Switching between the two files keeps the position and whether it was playing.
  const resume = useRef<{ at: number; playing: boolean } | null>(null);
  // Set when the chosen video is to be shown once it is in its place.
  const reveal = useRef(false);
  function choose(next: boolean, show = true) {
    const current = video.current;
    if (!current) return;
    reveal.current = show;
    if (next !== previewing) {
      resume.current = { at: current.currentTime, playing: !current.paused };
      onPreview(next);
    } else if (show) {
      reveal.current = false;
      current.scrollIntoView({ block: "center", behavior: "smooth" });
      current.focus({ preventScroll: true });
    }
  }
  useEffect(() => {
    // Right after a move this render still holds the element that left; the one that arrived comes next.
    if (!reveal.current || !element?.isConnected) return;
    reveal.current = false;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.focus({ preventScroll: true });
  }, [element, preview]);
  useImperativeHandle(player, () => ({
    playShot(index: number) {
      const current = video.current;
      if (!current) return;
      current.currentTime = timing.slice(0, index).reduce((sum, shot) => sum + shot.durationSec, 0)
        || (rendered ?? draft).storyboard.slice(0, index).reduce((sum, shot) => sum + shot.durationSec, 0);
      current.scrollIntoView({ block: "nearest", behavior: "smooth" });
      void current.play().catch(() => {});
    },
    showPreview: choose,
  }), [timing, rendered, draft, previewing, onPreview]);
  const layout = box && captionLayout(box.frame.width, box.frame.height, draft.captions);
  const frame = <div className="mv-result-player">
    <div className="mv-result-frame">
      <video ref={attach} className="mv-result-video" controls src={preview ? previewUrl : url} onLoadedMetadata={e => {
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
  </div>;
  return preview && slot ? <>
    <p className="mv-hint mv-player-moved" role="note">{t("实时预览显示在下方「成片设置」中，点击")}
      <button type="button" onClick={() => choose(false)}>{t("原成片")}</button>{t("回到这里播放。")}</p>
    {createPortal(frame, slot)}
  </> : frame;
}

/** Chooses between the made video and its live caption preview, from the caption settings, beside the button that
 * composes a preview video; `onCompose` is absent while one cannot be composed. The live preview plays in `onSlot`. */
export function CaptionPreviewModes({ preview, draft, timing, onChoose, onCompose, onSlot }: {
  preview: boolean; draft: MarketingDraft; timing: CaptionTiming;
  onChoose(preview: boolean): void; onCompose?: () => void; onSlot(node: HTMLDivElement | null): void;
}) {
  const { t, locale } = useI18n();
  const { changed } = usePreviewCaptions(preview, draft, timing);
  const shotList = changed.map(index => index + 1).join(locale === "zh" ? "、" : ", ");
  return <>
    <div className="mv-composition-actions">
      <div className="mv-preview-modes" role="group" aria-label={t("字幕预览")}>
        <button type="button" className={preview ? "" : "selected"} aria-pressed={!preview} onClick={() => onChoose(false)}>{t("原成片")}</button>
        <button type="button" className={preview ? "selected" : ""} aria-pressed={preview} onClick={() => onChoose(true)}>{t("实时预览")}</button>
      </div>
      {PREVIEW_VIDEO && <button type="button" disabled={!onCompose} onClick={onCompose}>{t("生成预览成片")}</button>}
    </div>
    <div ref={onSlot} className="mv-live-slot" />
    {preview && <p className="mv-hint" role="status">{t("实时预览只在页面上叠加字幕，与成片的字体渲染可能略有差别。满意后点击「重新合成成片」。")}
      {!!changed.length && ` ${t("第 {0} 镜口播已修改，重新合成后才能预览该镜字幕。", [shotList])}`}</p>}
  </>;
}

/** The caption on screen. While a captioned video plays it is read each frame, so captions change on time, but the
 * page only updates when the caption changes. */
function useCaptionLine(video: HTMLVideoElement | null, captions: MarketingCaption[]) {
  const [line, setLine] = useState<string>();
  useEffect(() => {
    if (!video || !captions.length) { setLine(undefined); return; }
    let frame = 0;
    const read = () => setLine(captions.find(cue => video.currentTime >= cue.start && video.currentTime < cue.end)?.text);
    const tick = () => { read(); if (!video.paused && !video.ended) frame = requestAnimationFrame(tick); };
    const play = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); };
    const events = ["seeked", "timeupdate", "loadedmetadata"] as const;
    video.addEventListener("play", play);
    for (const name of events) video.addEventListener(name, read);
    read();
    if (!video.paused) play();
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener("play", play);
      for (const name of events) video.removeEventListener(name, read);
    };
  }, [video, captions]);
  return line;
}

/** Where the picture sits inside the video element (it is letterboxed to fit), and its scale to the composed frame. */
function useVideoBox(video: HTMLVideoElement | null, frame: { width: number; height: number }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!video || typeof ResizeObserver === "undefined") return;
    const measure = () => setSize({ width: video.clientWidth, height: video.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(video); measure();
    return () => observer.disconnect();
  }, [video]);
  if (!size?.width || !size.height) return null;
  const scale = Math.min(size.width / frame.width, size.height / frame.height);
  const width = frame.width * scale, height = frame.height * scale;
  return { frame, scale, width, height, left: (size.width - width) / 2, top: (size.height - height) / 2 };
}
