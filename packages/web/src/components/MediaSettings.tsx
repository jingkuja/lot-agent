import { useState, useRef, useEffect } from "react";
import { isGptImage15 } from "../lib/model-filter.js";
import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  IMAGE_PRESETS,
  IMAGE_QUALITIES,
  imageSizeError,
  isMultipleOf16,
  parseDim,
  parseImageSize,
  type ImageSettings,
} from "../lib/image-settings.js";

export type { ImageSettings } from "../lib/image-settings.js";
export { IMAGE_PRESETS, IMAGE_QUALITIES } from "../lib/image-settings.js";

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

export interface Quality {
  label: string;
  short: string;
  /** 短边像素，分辨率由它和比例推导。 */
  edge: number;
}

export const VIDEO_QUALITIES: Quality[] = [
  { label: "480p标清", short: "480p", edge: 480 },
  { label: "720p高清", short: "720p", edge: 720 },
  { label: "1080p超清", short: "1080p", edge: 1080 },
];

export const VIDEO_DURATIONS = ["5秒", "10秒"];

export interface VideoSettings { size: string; durationSec: number; ratio: string; quality: string }

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

/* ── 图像生成：分辨率（三档预设 + 自定义）+ 质量 ── */

// Remembered for the page session. The input box is unmounted/remounted when the
// conversation switches between its empty (hero) and message-list layouts (e.g.
// on the first send), which would otherwise reset the picker to its default.
const lastImage = {
  size: DEFAULT_IMAGE_SIZE,
  quality: DEFAULT_IMAGE_QUALITY,
};

function splitSize(size: string): { width: string; height: string } {
  const dim = parseImageSize(size);
  if (dim) return { width: String(dim.width), height: String(dim.height) };
  const [width = "", height = ""] = size.split("x");
  return { width, height };
}

export function ImageSettingsPicker({
  disabled,
  selectedModel,
  onChange,
  onError,
}: {
  disabled?: boolean;
  selectedModel?: string | null;
  onChange?: (s: ImageSettings) => void;
  onError?: (error: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useDismiss(open, () => setOpen(false));
  const allowCustom = !isGptImage15(selectedModel);
  const [size, setSize] = useState(() => {
    if (allowCustom || IMAGE_PRESETS.some((p) => p.size === lastImage.size)) return lastImage.size;
    lastImage.size = DEFAULT_IMAGE_SIZE;
    return DEFAULT_IMAGE_SIZE;
  });
  const [quality, setQuality] = useState(() => lastImage.quality);
  const [widthStr, setWidthStr] = useState(() => splitSize(size).width);
  const [heightStr, setHeightStr] = useState(() => splitSize(size).height);

  const applySize = (next: string) => {
    lastImage.size = next;
    setSize(next);
    const parts = splitSize(next);
    setWidthStr(parts.width);
    setHeightStr(parts.height);
  };

  useEffect(() => {
    if (allowCustom) return;
    if (IMAGE_PRESETS.some((p) => p.size === lastImage.size)) return;
    applySize(DEFAULT_IMAGE_SIZE);
  }, [allowCustom]);

  const error = imageSizeError(size, selectedModel);
  const preset = IMAGE_PRESETS.find((p) => p.size === size);
  const qualityMeta = IMAGE_QUALITIES.find((q) => q.value === quality) ?? IMAGE_QUALITIES[0];
  const parsed = parseImageSize(size);
  const triggerGlyph = preset
    ? { w: preset.w, h: preset.h }
    : parsed
      ? { w: parsed.width, h: parsed.height }
      : { w: 1, h: 1 };

  useEffect(() => {
    onChange?.({ size, n: 1, quality });
    onError?.(error);
  }, [size, quality, error, onChange, onError]);

  const pickPreset = (next: string) => applySize(next);
  const pickQuality = (value: string) => {
    lastImage.quality = value;
    setQuality(value);
  };
  const onDimChange = (nextWidth: string, nextHeight: string) => {
    if (!allowCustom) return;
    const width = nextWidth.replace(/[^\d]/g, "");
    const height = nextHeight.replace(/[^\d]/g, "");
    setWidthStr(width);
    setHeightStr(height);
    const w = parseDim(width);
    const h = parseDim(height);
    const next = w != null && h != null ? `${w}x${h}` : `${width}x${height}`;
    lastImage.size = next;
    setSize(next);
  };
  const widthInvalid = !isMultipleOf16(parseDim(widthStr) ?? 0);
  const heightInvalid = !isMultipleOf16(parseDim(heightStr) ?? 0);

  const sizeLabel = parsed ? `${parsed.width}×${parsed.height}` : size.replace("x", "×");

  return (
    <div className="media-picker" ref={wrapRef}>
      <button
        type="button"
        className="media-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        title="图片设置"
      >
        <RatioGlyph w={triggerGlyph.w} h={triggerGlyph.h} size={14} />
        <span className="media-trigger-label">{sizeLabel} · {qualityMeta.label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="media-popup">
          <div className="media-section-title">分辨率</div>
          <div className="seg-track">
            {IMAGE_PRESETS.map((p) => (
              <button
                key={p.size}
                type="button"
                className={`seg seg--stack ${p.size === size ? "active" : ""}`}
                onClick={() => pickPreset(p.size)}
              >
                <RatioGlyph w={p.w} h={p.h} size={20} />
                <span>{p.label}</span>
                <small>{p.size.replace("x", "×")}</small>
              </button>
            ))}
          </div>
          <div className="media-section-title">自定义分辨率</div>
          {allowCustom ? (
            <>
              <div className="res-row">
                <label className={`res-field${widthInvalid ? " res-field--invalid" : ""}`}>
                  <span className="res-key">W</span>
                  <input
                    className="res-input"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={widthStr}
                    onChange={(e) => onDimChange(e.target.value, heightStr)}
                    aria-invalid={widthInvalid}
                    aria-label="宽度"
                  />
                </label>
                <span className="res-link" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 5.93" />
                    <path d="M14 11a5 5 0 0 0-7.07 0L5.52 12.41a5 5 0 0 0 7.07 7.07L14 18.07" />
                  </svg>
                </span>
                <label className={`res-field${heightInvalid ? " res-field--invalid" : ""}`}>
                  <span className="res-key">H</span>
                  <input
                    className="res-input"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={heightStr}
                    onChange={(e) => onDimChange(widthStr, e.target.value)}
                    aria-invalid={heightInvalid}
                    aria-label="高度"
                  />
                </label>
              </div>
              <div className="media-hint">宽和高都必须能被 16 整除，总像素不能低于 655360，宽高比不能超过 1:3 或 3:1</div>
              {error && <div className="media-hint media-hint--error">{error}</div>}
            </>
          ) : (
            <div className="media-hint">当前模型不支持自定义分辨率</div>
          )}
          <div className="media-section-title">质量</div>
          <div className="seg-track">
            {IMAGE_QUALITIES.map((q) => (
              <button
                key={q.value}
                type="button"
                className={`seg ${q.value === quality ? "active" : ""}`}
                onClick={() => pickQuality(q.value)}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 视频生成：质量 + 比例 + 分辨率 + 时长 ── */

// Session-remembered video selection — same remount survival as the image picker
// (see lastImage).
const lastVideo = {
  quality: VIDEO_QUALITIES[0].short,
  ratio: VIDEO_RATIOS[0].label,
  duration: VIDEO_DURATIONS[0],
};

export function VideoSettingsPicker({
  disabled,
  lockAdaptive,
  onChange,
  durations = VIDEO_DURATIONS,
}: {
  disabled?: boolean;
  /** Seedance + 参考视频：时长/比例固定为自动适配，页面不可改。 */
  lockAdaptive?: boolean;
  onChange?: (s: VideoSettings) => void;
  /** 时长选项，默认 5秒 / 10秒；获客宝使用 10秒 / 15秒。 */
  durations?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useDismiss(open, () => setOpen(false));
  const durationOptions = durations.length ? durations : VIDEO_DURATIONS;
  const defaultDuration = durationOptions[0];
  const [quality, setQuality] = useState<Quality>(
    () => VIDEO_QUALITIES.find((q) => q.short === lastVideo.quality) ?? VIDEO_QUALITIES[0]
  );
  const [ratio, setRatio] = useState<Ratio>(
    () => VIDEO_RATIOS.find((r) => r.label === lastVideo.ratio) ?? VIDEO_RATIOS[0] // 16:9
  );
  const [duration, setDuration] = useState(
    () => (durationOptions.includes(lastVideo.duration) ? lastVideo.duration : defaultDuration)
  );
  const [dim, setDim] = useState<Dim>(() => deriveResolution(ratio.w, ratio.h, quality.edge));

  useEffect(() => {
    if (durationOptions.includes(duration)) return;
    setDuration(defaultDuration);
  }, [duration, durationOptions, defaultDuration]);

  useEffect(() => {
    const fallbackSec = Number(defaultDuration.replace(/[^0-9]/g, "")) || 5;
    onChange?.({
      size: `${dim.width}x${dim.height}`,
      durationSec: lockAdaptive ? -1 : Number(duration.replace(/[^0-9]/g, "")) || fallbackSec,
      ratio: lockAdaptive ? "adaptive" : ratio.label,
      quality: quality.short,
    });
  }, [dim, duration, ratio, quality, lockAdaptive, onChange, defaultDuration]);

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

  return (
    <div className="media-picker" ref={wrapRef}>
      <button
        type="button"
        className="media-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        title={lockAdaptive ? "提供参考视频后视频时长和比例不能选择，自动适配参考视频" : "视频设置"}
      >
        <ResBarIcon />
        <span className="media-trigger-label">
          {quality.short} · {lockAdaptive ? "自适应" : ratio.label}
        </span>
        <TimerIcon />
        <span className="media-trigger-label">{lockAdaptive ? "自动" : duration}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="media-popup">
          <div className="media-section-title">视频质量</div>
          <div className="seg-track">
            {VIDEO_QUALITIES.map((q) => (
              <button
                key={q.short}
                type="button"
                className={`seg ${q.short === quality.short ? "active" : ""}`}
                onClick={() => pickQuality(q)}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="media-section-title">视频比例</div>
          <div className="seg-track">
            {lockAdaptive ? (
              <button type="button" className="seg active" disabled title="提供参考视频后自动适配参考视频">
                自适应
              </button>
            ) : (
              VIDEO_RATIOS.map((r) => (
                <button
                  key={r.label}
                  type="button"
                  className={`seg ${r.label === ratio.label ? "active" : ""}`}
                  onClick={() => pickRatio(r)}
                >
                  <RatioGlyph w={r.w} h={r.h} size={16} />
                  <span>{r.label}</span>
                </button>
              ))
            )}
          </div>
          <div className="media-section-title">视频时长</div>
          <div className="seg-track">
            {lockAdaptive ? (
              <button type="button" className="seg active" disabled title="提供参考视频后自动适配参考视频">
                <TimerIcon />
                <span>自动</span>
              </button>
            ) : (
              durationOptions.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`seg ${d === duration ? "active" : ""}`}
                  onClick={() => pickDuration(d)}
                >
                  <TimerIcon />
                  <span>{d}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
