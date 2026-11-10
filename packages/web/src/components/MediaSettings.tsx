import { useI18n } from "../i18n/index.js";
import { useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from "react";
import { imageModelDescription, isLingquImage } from "../lib/model-filter.js";
import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_RATIO,
  DEFAULT_IMAGE_RESOLUTION,
  IMAGE_AUTO_RATIO,
  IMAGE_MAX_COUNT,
  IMAGE_QUALITIES,
  IMAGE_RATIOS,
  IMAGE_RESOLUTIONS,
  type ImageSettings,
} from "../lib/image-settings.js";
import {
  VIDEO_QUALITIES,
  pickVideoQuality,
  videoQualitiesForModel,
  type VideoQuality,
} from "../lib/video-settings.js";

export type { ImageSettings } from "../lib/image-settings.js";
export { IMAGE_QUALITIES } from "../lib/image-settings.js";

export interface Ratio {
  label: string;
  w: number;
  h: number;
}

/** 视频生成比例选项。 */
export const VIDEO_RATIOS: Ratio[] = [
  { label: "16:9", w: 16, h: 9 },
  { label: "9:16", w: 9, h: 16 },
  { label: "1:1", w: 1, h: 1 },
];

export type Quality = VideoQuality;
export {
  VIDEO_QUALITIES,
  KLING_VIDEO_QUALITIES,
  MINIMAX_H3_VIDEO_QUALITIES,
  H3_MAX_VIDEO_QUALITIES,
  videoQualitiesForModel,
} from "../lib/video-settings.js";

export const VIDEO_DURATIONS = Array.from({ length: 12 }, (_, i) => `${i + 4}秒`);

export interface VideoSettings {
  size: string;
  durationSec: number;
  ratio: string;
  quality: string;
  generate_audio: boolean;
}

interface Dim {
  width: number;
  height: number;
}

/** 由比例 + 短边推导分辨率（长边对齐到 8 的倍数）。纯前端，仅用于展示。 */
export function deriveResolution(rw: number, rh: number, shortEdge: number): Dim {
  const long = Math.round((shortEdge * Math.max(rw, rh)) / Math.min(rw, rh) / 8) * 8;
  return rw >= rh ? { width: long, height: shortEdge } : { width: shortEdge, height: long };
}

/** A bordered rounded rect scaled to the ratio, fit inside a `size` box. */
export function RatioGlyph({ w, h, size }: { w: number; h: number; size: number }) {
  const rw = w >= h ? size : (size * w) / h;
  const rh = h >= w ? size : (size * h) / w;
  return <span className="ratio-glyph" style={{ width: rw, height: rh }} aria-hidden />;
}

/** Outside-click + Escape dismissal for an open popover; returns the wrapper ref. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function ChevronIcon() {
  return (
    <svg className="media-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function TimerIcon() {
  return (
    <svg className="media-timer" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="9.5" y1="2.5" x2="14.5" y2="2.5" />
      <line x1="12" y1="2.5" x2="12" y2="5" />
      <circle cx="12" cy="13" r="7.5" />
      <line x1="12" y1="13" x2="12" y2="9" />
    </svg>
  );
}

function ResBarIcon() {
  return (
    <svg className="media-resbar" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2.5" y="8" width="19" height="8" rx="4" />
      <rect x="5.5" y="11" width="8" height="2" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* ── 图像生成：张数 · 质量 · 模型 · 比例 · 清晰度 ── */

// Remembered for the page session. The input box is unmounted/remounted when the
// conversation switches between its empty (hero) and message-list layouts (e.g.
// on the first send), which would otherwise reset the picker to its default.
const lastImage = {
  /** Count per image type: each type starts from its own default and keeps the user's choice separately. */
  counts: {} as Record<string, number>,
  quality: DEFAULT_IMAGE_QUALITY,
  ratio: DEFAULT_IMAGE_RATIO as string,
  resolution: DEFAULT_IMAGE_RESOLUTION as string,
};

function AutoRatioIcon() {
  return (
    <svg className="image-ratio-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <polyline points="8 12 8 8 12 8" />
      <polyline points="16 12 16 16 12 16" />
    </svg>
  );
}

/** Visible vertical band for `el`: the viewport narrowed by every clipping ancestor (the chat panel hides overflow). */
function visibleBand(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/hidden|auto|scroll|clip/.test(`${style.overflow} ${style.overflowY}`)) {
      const rect = node.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
  }
  return { top, bottom };
}

const POPUP_GAP = 10;
const POPUP_EDGE = 8;
const POPUP_MAX_HEIGHT = 640;

export interface ImageModelOption {
  id: string;
  label?: string;
  description?: string;
}

export function ImageSettingsPicker({
  disabled,
  models = [],
  selectedModel,
  onModelChange,
  allowCount = true,
  countKey = "free",
  defaultCount = 1,
  showSummary = false,
  onChange,
}: {
  disabled?: boolean;
  /** Visible image models (already labeled 默认 / 旗舰 / 电商爆款); shown only with `onModelChange`. */
  models?: ImageModelOption[];
  selectedModel?: string | null;
  onModelChange?: (id: string) => void;
  /** Hide the image count where only one image is kept (获客宝 posters). */
  allowCount?: boolean;
  /** Image type the count belongs to; switching types switches to that type's remembered or default count. */
  countKey?: string;
  defaultCount?: number;
  /** Show the live output specification on the image studio's settings button. */
  showSummary?: boolean;
  onChange?: (s: ImageSettings) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useDismiss(open, () => setOpen(false));
  const [counts, setCounts] = useState(() => ({ ...lastImage.counts }));
  const n = counts[countKey] ?? defaultCount;
  const [quality, setQuality] = useState(() => lastImage.quality);
  const [ratio, setRatio] = useState(() => lastImage.ratio);
  const [resolution, setResolution] = useState(() => lastImage.resolution);
  const count = allowCount ? n : 1;
  // Open upward unless the space above is short and below is roomier; never past the visible band.
  const [placement, setPlacement] = useState<{ below: boolean; maxHeight: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const band = visibleBand(wrap);
      const rect = wrap.getBoundingClientRect();
      const above = rect.top - band.top - POPUP_GAP - POPUP_EDGE;
      const below = band.bottom - rect.bottom - POPUP_GAP - POPUP_EDGE;
      const openBelow = above < 360 && below > above;
      const width = wrap.querySelector(".image-settings-popup")?.getBoundingClientRect().width ?? 0;
      const left = Math.max(POPUP_EDGE, Math.min(rect.right - width, window.innerWidth - width - POPUP_EDGE)) - rect.left;
      setPlacement({ below: openBelow, maxHeight: Math.max(160, Math.min(POPUP_MAX_HEIGHT, openBelow ? below : above)), left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, wrapRef]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    onChange?.({ resolution, ratio, n: count, quality });
  }, [resolution, ratio, count, quality, onChange]);

  const pickN = (value: number) => {
    const next = Math.min(IMAGE_MAX_COUNT, Math.max(1, Math.round(value) || 1));
    lastImage.counts[countKey] = next;
    setCounts((current) => ({ ...current, [countKey]: next }));
  };
  const pickQuality = (value: string) => {
    lastImage.quality = value;
    setQuality(value);
  };
  const pickRatio = (value: string) => {
    lastImage.ratio = value;
    setRatio(value);
  };
  const pickResolution = (value: string) => {
    lastImage.resolution = value;
    setResolution(value);
  };
  const [rw, rh] = ratio === IMAGE_AUTO_RATIO ? [1, 1] : ratio.split(":").map(Number);
  const modelOptions = [...models].sort((a, b) => Number(isLingquImage(b.id)) - Number(isLingquImage(a.id)));

  return (
    <div className="media-picker" ref={wrapRef}>
      <button
        type="button"
        className="media-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("图片参数")}
      >
        <RatioGlyph w={rw} h={rh} size={14} />
        <span className="media-trigger-label">{t("图片参数")}</span>
        {showSummary && <span className="image-settings-summary">
          {resolution} · {ratio === IMAGE_AUTO_RATIO ? t("智能") : ratio} · {t("{0} 张", [count])}
        </span>}
        <ChevronIcon />
      </button>
      {open && (
        <div
          className={`media-popup image-settings-popup${placement?.below ? " media-popup--below" : ""}`}
          style={placement ? { maxHeight: placement.maxHeight, left: placement.left, right: "auto" } : undefined}
          role="dialog"
          aria-label={t("图片参数")}
        >
          <div className="media-section-title">{t("清晰度")}</div>
          <div className="seg-track">
            {IMAGE_RESOLUTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className={`seg ${value === resolution ? "active" : ""}`}
                onClick={() => pickResolution(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="media-section-title">{t("质量")}</div>
          <div className="seg-track">
            {IMAGE_QUALITIES.map((q) => (
              <button
                key={q.value}
                type="button"
                className={`seg ${q.value === quality ? "active" : ""}`}
                onClick={() => pickQuality(q.value)}
              >
                {t(q.label)}
              </button>
            ))}
          </div>
          {onModelChange && (
            <>
              <div className="media-section-title">{t("模型")}</div>
              {models.length ? (
                <div className="image-model-grid">
                  {modelOptions.map((model) => {
                    const description = imageModelDescription(model.id) ?? model.description;
                    const featured = isLingquImage(model.id) ? " image-model-card--featured" : "";
                    return (
                      <button
                        key={model.id}
                        type="button"
                        className={`image-model-card${featured}${model.id === selectedModel ? " active" : ""}`}
                        onClick={() => onModelChange(model.id)}
                        aria-pressed={model.id === selectedModel}
                        aria-label={t(model.label ?? model.id)}
                        title={description ? t(description) : undefined}
                      >
                        <span>{t(model.label ?? model.id)}</span>
                        {description && <small>{t(description)}</small>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="media-hint">{t("暂无模型")}</div>
              )}
            </>
          )}
          <div className="media-section-title">{t("图片比例")}</div>
          <div className="seg-track image-ratio-grid">
            {[IMAGE_AUTO_RATIO, ...IMAGE_RATIOS].map((value) => {
              const [w, h] = value === IMAGE_AUTO_RATIO ? [1, 1] : value.split(":").map(Number);
              return (
                <button
                  key={value}
                  type="button"
                  className={`seg seg--stack ${value === ratio ? "active" : ""}`}
                  onClick={() => pickRatio(value)}
                >
                  <span className="image-ratio-icon" aria-hidden>
                    {value === IMAGE_AUTO_RATIO ? <AutoRatioIcon /> : <RatioGlyph w={w} h={h} size={18} />}
                  </span>
                  <span>{value === IMAGE_AUTO_RATIO ? t("智能") : value}</span>
                </button>
              );
            })}
          </div>
          {ratio === IMAGE_AUTO_RATIO && <div className="media-hint">{t("有参考图时跟随第一张参考图的比例，否则为 1:1")}</div>}
          {allowCount && (
            <>
              <div className="media-section-title">{t("图片张数")}</div>
              <div className="image-count">
                <input
                  type="range"
                  min={1}
                  max={IMAGE_MAX_COUNT}
                  step={1}
                  value={n}
                  onChange={(e) => pickN(Number(e.target.value))}
                  aria-label={t("图片张数")}
                  style={{ "--fill": `${((n - 1) / (IMAGE_MAX_COUNT - 1)) * 100}%` } as CSSProperties}
                />
                <div className="image-count-ticks" aria-hidden>
                  {Array.from({ length: IMAGE_MAX_COUNT }, (_, i) => (
                    <span key={i} className={i + 1 === n ? "active" : ""}>{i + 1}</span>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── 视频生成：质量 + 比例 + 分辨率 + 时长 + 声音 ── */

// Session-remembered video selection — same remount survival as the image picker
// (see lastImage).
const lastVideo = {
  quality: VIDEO_QUALITIES[0].short,
  ratio: VIDEO_RATIOS[0].label,
  duration: "5秒",
  generateAudio: false,
};

export function VideoSettingsPicker({
  disabled,
  lockAdaptive,
  hasReferenceAudio = false,
  hasReferenceMedia = false,
  selectedModel,
  onChange,
  durations = VIDEO_DURATIONS,
}: {
  disabled?: boolean;
  /** Seedance + 参考视频：时长/比例固定为自动适配，页面不可改。 */
  lockAdaptive?: boolean;
  /** 有参考音频时供应商必须生成声音，页面不可改。 */
  hasReferenceAudio?: boolean;
  /** 有参考图或参考视频；Grok 此时最高 720p。 */
  hasReferenceMedia?: boolean;
  /** 当前视频模型；Kling / MiniMax H3 / H3 Max / Grok 使用各自的分辨率档位。 */
  selectedModel?: string | null;
  onChange?: (s: VideoSettings) => void;
  /** 时长选项，默认 4～15秒；获客宝使用 10秒 / 15秒。 */
  durations?: readonly string[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useDismiss(open, () => setOpen(false));
  const durationOptions = durations.length ? durations : VIDEO_DURATIONS;
  const defaultDuration = durationOptions[0];
  const qualityOptions = videoQualitiesForModel(selectedModel, hasReferenceMedia);
  const [quality, setQuality] = useState<Quality>(() => {
    const next = pickVideoQuality(qualityOptions, lastVideo.quality);
    lastVideo.quality = next.short;
    return next;
  });
  const [ratio, setRatio] = useState<Ratio>(
    () => VIDEO_RATIOS.find((r) => r.label === lastVideo.ratio) ?? VIDEO_RATIOS[0] // 16:9
  );
  const [duration, setDuration] = useState(
    () => (durationOptions.includes(lastVideo.duration) ? lastVideo.duration : defaultDuration)
  );
  const [generateAudio, setGenerateAudio] = useState(() => lastVideo.generateAudio);
  const [dim, setDim] = useState<Dim>(() => deriveResolution(ratio.w, ratio.h, quality.edge));
  const effectiveGenerateAudio = hasReferenceAudio || generateAudio;

  useEffect(() => {
    if (durationOptions.includes(duration)) return;
    // Keep the longest choice that still fits, e.g. 15秒 → 8秒 when a reference video caps it.
    const seconds = Number(duration.replace(/[^0-9]/g, ""));
    const fitting = durationOptions.filter((option) => Number(option.replace(/[^0-9]/g, "")) <= seconds);
    setDuration(fitting.at(-1) ?? defaultDuration);
  }, [duration, durationOptions, defaultDuration]);

  useEffect(() => {
    const next = pickVideoQuality(qualityOptions, quality.short);
    if (next.short === quality.short) return;
    lastVideo.quality = next.short;
    setQuality(next);
    setDim(deriveResolution(ratio.w, ratio.h, next.edge));
  }, [qualityOptions, quality, ratio]);

  useEffect(() => {
    const fallbackSec = Number(defaultDuration.replace(/[^0-9]/g, "")) || 5;
    onChange?.({
      size: `${dim.width}x${dim.height}`,
      durationSec: lockAdaptive ? -1 : Number(duration.replace(/[^0-9]/g, "")) || fallbackSec,
      ratio: lockAdaptive ? "adaptive" : ratio.label,
      quality: quality.short,
      generate_audio: effectiveGenerateAudio,
    });
  }, [dim, duration, ratio, quality, lockAdaptive, onChange, defaultDuration, effectiveGenerateAudio]);

  const pickQuality = (q: Quality) => {
    lastVideo.quality = q.short;
    setQuality(q);
    setDim(deriveResolution(ratio.w, ratio.h, q.edge));
  };
  const pickRatio = (r: Ratio) => {
    if (lockAdaptive) return;
    lastVideo.ratio = r.label;
    setRatio(r);
    setDim(deriveResolution(r.w, r.h, quality.edge));
  };
  const pickDuration = (d: string) => {
    if (lockAdaptive) return;
    lastVideo.duration = d;
    setDuration(d);
  };
  const pickGenerateAudio = (value: boolean) => {
    if (hasReferenceAudio) return;
    lastVideo.generateAudio = value;
    setGenerateAudio(value);
  };

  return (
    <div className="media-picker" ref={wrapRef}>
      <button
        type="button"
        className="media-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        title={lockAdaptive ? t("提供参考视频后视频时长和比例不能选择，自动适配参考视频") : t("视频设置")}
      >
        <ResBarIcon />
        <span className="media-trigger-label">
          {quality.short} · {lockAdaptive ? t("自适应") : t(ratio.label)}
        </span>
        <TimerIcon />
        <span className="media-trigger-label">{lockAdaptive ? t("自动") : t(duration)}</span>
        <span className="media-trigger-audio" aria-label={effectiveGenerateAudio ? t("有声音") : t("无声音")}>
          {effectiveGenerateAudio ? "🔊" : "🔇"}
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="media-popup">
          <div className="media-section-title">{t("视频质量")}</div>
          <div className="seg-track">
            {qualityOptions.map((q) => (
              <button
                key={q.short}
                type="button"
                className={`seg ${q.short === quality.short ? "active" : ""}`}
                onClick={() => pickQuality(q)}
              >
                {t(q.label)}
              </button>
            ))}
          </div>
          <div className="media-section-title">{t("视频比例")}</div>
          <div className="seg-track">
            {lockAdaptive ? (
              <button type="button" className="seg active" disabled title={t("提供参考视频后自动适配参考视频")}>
                {t("自适应")}</button>
            ) : (
              VIDEO_RATIOS.map((r) => (
                <button
                  key={r.label}
                  type="button"
                  className={`seg ${r.label === ratio.label ? "active" : ""}`}
                  onClick={() => pickRatio(r)}
                >
                  <RatioGlyph w={r.w} h={r.h} size={16} />
                  <span>{t(r.label)}</span>
                </button>
              ))
            )}
          </div>
          <div className="media-section-title">{t("视频时长")}</div>
          <div className="seg-track">
            {lockAdaptive ? (
              <button type="button" className="seg active" disabled title={t("提供参考视频后自动适配参考视频")}>
                <TimerIcon />
                <span>{t("自动")}</span>
              </button>
            ) : (
              <label className="video-duration-slider">
                <span className="video-duration-labels"><span>{t(durationOptions[0])}</span><output>{t(duration)}</output><span>{t(durationOptions[durationOptions.length - 1])}</span></span>
                <input
                  type="range"
                  aria-label={t("视频时长")}
                  aria-valuetext={t(duration)}
                  min={0}
                  max={durationOptions.length - 1}
                  step={1}
                  value={Math.max(0, durationOptions.indexOf(duration))}
                  disabled={disabled}
                  onChange={(e) => pickDuration(durationOptions[Number(e.target.value)])}
                />
              </label>
            )}
          </div>
          <div className="media-section-title">{t("视频声音")}</div>
          <div className="seg-track">
            {[
              { value: true, label: "有" },
              { value: false, label: "无" },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                className={`seg ${option.value === effectiveGenerateAudio ? "active" : ""}`}
                disabled={disabled || hasReferenceAudio}
                title={hasReferenceAudio ? t("存在参考音频时固定为有") : undefined}
                onClick={() => pickGenerateAudio(option.value)}
              >
                <span aria-hidden>{option.value ? "🔊" : "🔇"}</span>
                <span>{t(option.label)}</span>
              </button>
            ))}
          </div>
          {hasReferenceAudio && <div className="media-hint">{t("已上传参考音频，视频声音固定为有")}</div>}
        </div>
      )}
    </div>
  );
}
