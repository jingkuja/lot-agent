import { isH3MaxModel, isKlingModel, isMinimaxH3Model } from "./model-filter.js";

export interface VideoQuality {
  label: string;
  short: string;
  /** 短边像素，分辨率由它和比例推导。 */
  edge: number;
}

export const VIDEO_QUALITIES: VideoQuality[] = [
  { label: "480p标清", short: "480p", edge: 480 },
  { label: "720p高清", short: "720p", edge: 720 },
  { label: "1080p超清", short: "1080p", edge: 1080 },
];

/** Kling 视频模型不提供 480p，额外支持 4K。 */
export const KLING_VIDEO_QUALITIES: VideoQuality[] = [
  { label: "720p高清", short: "720p", edge: 720 },
  { label: "1080p超清", short: "1080p", edge: 1080 },
  { label: "4K超清", short: "4k", edge: 2160 },
];

/** MiniMax H3（`minimax-video-h3`）仅支持 768P / 2K。2K 短边为 1440。 */
export const MINIMAX_H3_VIDEO_QUALITIES: VideoQuality[] = [
  { label: "768P高清", short: "768p", edge: 768 },
  { label: "2K超清", short: "2k", edge: 1440 },
];

/** MiniMax H3 Max（`h3-max`）仅支持 480P / 768P。 */
export const H3_MAX_VIDEO_QUALITIES: VideoQuality[] = [
  { label: "480p标清", short: "480p", edge: 480 },
  { label: "768P高清", short: "768p", edge: 768 },
];

const ALL_VIDEO_QUALITIES: VideoQuality[] = [
  ...VIDEO_QUALITIES,
  ...KLING_VIDEO_QUALITIES,
  ...MINIMAX_H3_VIDEO_QUALITIES,
  ...H3_MAX_VIDEO_QUALITIES,
];

export function videoQualitiesForModel(id: string | null | undefined): VideoQuality[] {
  if (isH3MaxModel(id)) return H3_MAX_VIDEO_QUALITIES;
  if (isMinimaxH3Model(id)) return MINIMAX_H3_VIDEO_QUALITIES;
  return isKlingModel(id) ? KLING_VIDEO_QUALITIES : VIDEO_QUALITIES;
}

/** Keep the current ladder step when it is still valid; otherwise the nearest edge. */
export function pickVideoQuality(options: VideoQuality[], currentShort: string): VideoQuality {
  const exact = options.find((q) => q.short === currentShort);
  if (exact) return exact;
  const known = ALL_VIDEO_QUALITIES.find((q) => q.short === currentShort);
  if (!known) return options[0];
  return options.reduce((best, q) =>
    Math.abs(q.edge - known.edge) < Math.abs(best.edge - known.edge) ? q : best
  );
}
