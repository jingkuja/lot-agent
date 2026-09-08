import { isKlingModel } from "./model-filter.js";

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

export function videoQualitiesForModel(id: string | null | undefined): VideoQuality[] {
  return isKlingModel(id) ? KLING_VIDEO_QUALITIES : VIDEO_QUALITIES;
}

/** Keep the current ladder step when it is still valid; otherwise the nearest edge. */
export function pickVideoQuality(options: VideoQuality[], currentShort: string): VideoQuality {
  const exact = options.find((q) => q.short === currentShort);
  if (exact) return exact;
  const known = [...VIDEO_QUALITIES, ...KLING_VIDEO_QUALITIES].find((q) => q.short === currentShort);
  if (!known) return options[0];
  return options.reduce((best, q) =>
    Math.abs(q.edge - known.edge) < Math.abs(best.edge - known.edge) ? q : best
  );
}
