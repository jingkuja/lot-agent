import { useState, useRef, useEffect } from "react";

export interface Ratio {
  label: string;
  w: number;
  h: number;
}

/** 图像比例选项。每个比例对应一个固定分辨率（该比例下接口支持的最小分辨率），
 * 由后端的 gpt-image-2-token 接口直接消费。注意：接口只接受 `WxH` 格式
 * （`*` 会被判为不合法的 size），故这里用 `x` 分隔。 */
export interface ImageRatio extends Ratio {
  /** 该比例对应的固定分辨率，如 "2048x2048"。 */
  size: string;
}

export const IMAGE_RATIOS: ImageRatio[] = [
  { label: "16:9", w: 16, h: 9, size: "2688x1536" },
  { label: "4:3", w: 4, h: 3, size: "2368x1728" },
  { label: "1:1", w: 1, h: 1, size: "2048x2048" },
  { label: "3:4", w: 3, h: 4, size: "1728x2368" },
  { label: "9:16", w: 9, h: 16, size: "1536x2688" },
];

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

export interface ImageSettings { size: string; n: number }
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

/* ── 图像生成：仅比例（分辨率由比例固定推导，后端自动对应最小分辨率） ── */

// Remembered for the page session. The input box is unmounted/remounted when the
// conversation switches between its empty (hero) and message-list layouts (e.g.
// on the first send), which would otherwise reset the picker to its default. Keep
// the last-chosen ratio in module scope so a selection made before sending stays.
let lastImageRatioLabel = "1:1";

export function ImageSettingsPicker({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (s: ImageSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useDismiss(open, () => setOpen(false));
  const [ratio, setRatio] = useState<ImageRatio>(
    () => IMAGE_RATIOS.find((r) => r.label === lastImageRatioLabel) ?? IMAGE_RATIOS[2] // 1:1 默认
  );

  useEffect(() => {
    onChange?.({ size: ratio.size, n: 1 });
  }, [ratio, onChange]);

  const pickRatio = (r: ImageRatio) => {
    lastImageRatioLabel = r.label;
    setRatio(r);
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
        title="图片比例"
      >
        <RatioGlyph w={ratio.w} h={ratio.h} size={14} />
        <span className="media-trigger-label">{ratio.label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="media-popup">
          <div className="media-section-title">图片比例</div>
          <div className="seg-track">
            {IMAGE_RATIOS.map((r) => (
              <button
                key={r.label}
                type="button"
                className={`seg seg--stack ${r.label === ratio.label ? "active" : ""}`}
                onClick={() => pickRatio(r)}
              >
                <RatioGlyph w={r.w} h={r.h} size={20} />
                <span>{r.label}</span>
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
// (see lastImageRatioLabel).
const lastVideo = {
  quality: VIDEO_QUALITIES[0].short,
  ratio: VIDEO_RATIOS[0].label,
  duration: VIDEO_DURATIONS[0],
};

export function VideoSettingsPicker({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (s: VideoSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useDismiss(open, () => setOpen(false));
  const [quality, setQuality] = useState<Quality>(
    () => VIDEO_QUALITIES.find((q) => q.short === lastVideo.quality) ?? VIDEO_QUALITIES[0]
  );
  const [ratio, setRatio] = useState<Ratio>(
    () => VIDEO_RATIOS.find((r) => r.label === lastVideo.ratio) ?? VIDEO_RATIOS[0] // 16:9
  );
  const [duration, setDuration] = useState(
    () => (VIDEO_DURATIONS.includes(lastVideo.duration) ? lastVideo.duration : VIDEO_DURATIONS[0])
  );
  const [dim, setDim] = useState<Dim>(() => deriveResolution(ratio.w, ratio.h, quality.edge));

  useEffect(() => {
    onChange?.({
      size: `${dim.width}x${dim.height}`,
      durationSec: Number(duration.replace(/[^0-9]/g, "")) || 5,
      ratio: ratio.label,
      quality: quality.short,
    });
  }, [dim, duration, ratio, quality, onChange]);

  const pickQuality = (q: Quality) => {
    lastVideo.quality = q.short;
    setQuality(q);
    setDim(deriveResolution(ratio.w, ratio.h, q.edge));
  };
  const pickRatio = (r: Ratio) => {
    lastVideo.ratio = r.label;
    setRatio(r);
    setDim(deriveResolution(r.w, r.h, quality.edge));
  };
  const pickDuration = (d: string) => {
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
        title="视频设置"
      >
        <ResBarIcon />
        <span className="media-trigger-label">
          {quality.short} · {ratio.label}
        </span>
        <TimerIcon />
        <span className="media-trigger-label">{duration}</span>
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
            {VIDEO_RATIOS.map((r) => (
              <button
                key={r.label}
                type="button"
                className={`seg ${r.label === ratio.label ? "active" : ""}`}
                onClick={() => pickRatio(r)}
              >
                <RatioGlyph w={r.w} h={r.h} size={16} />
                <span>{r.label}</span>
              </button>
            ))}
          </div>
          <div className="media-section-title">视频时长</div>
          <div className="seg-track">
            {VIDEO_DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={`seg ${d === duration ? "active" : ""}`}
                onClick={() => pickDuration(d)}
              >
                <TimerIcon />
                <span>{d}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
