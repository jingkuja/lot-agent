export const MAX_VIDEO_REFERENCE_IMAGES = 9;
export const MAX_VIDEO_REFERENCE_VIDEOS = 3;
export const MAX_VIDEO_REFERENCE_AUDIOS = 3;
const MAX_REFERENCE_SECONDS = 15;

export async function validateReferenceMedia<T>(
  files: readonly T[],
  label: "视频" | "音频",
  readDuration: (file: T) => Promise<number>,
): Promise<void> {
  if (files.length > 3) throw new Error(`参考${label}最多 3 段`);
  const durations = await Promise.all(files.map(readDuration));
  if (durations.some((duration) => !Number.isFinite(duration) || duration <= 0)) {
    throw new Error(`无法读取参考${label}时长，请更换文件`);
  }
  if (durations.reduce((sum, duration) => sum + duration, 0) > MAX_REFERENCE_SECONDS) {
    throw new Error(`参考${label}总时长不能超过 15 秒`);
  }
}

export interface MediaMetadata {
  duration: number;
  /** Displayed size after rotation; 0 for audio. */
  width: number;
  height: number;
}

const metadataCache = new WeakMap<File, MediaMetadata>();
/** Reads only the container header via the browser; no decoding or ffmpeg needed. */
export function readMediaMetadata(file: File): Promise<MediaMetadata> {
  const cached = metadataCache.get(file);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const element = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    };
    const fail = () => {
      cleanup();
      reject(new Error(`无法读取「${file.name}」的时长，请更换文件`));
    };
    const timer = window.setTimeout(fail, 10000);
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      const video = element instanceof HTMLVideoElement ? element : undefined;
      const metadata = { duration: element.duration, width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0 };
      cleanup();
      metadataCache.set(file, metadata);
      resolve(metadata);
    };
    element.onerror = fail;
    element.src = url;
  });
}

export async function readMediaDuration(file: File): Promise<number> {
  return (await readMediaMetadata(file)).duration;
}

export function cachedMediaMetadata(file: File): MediaMetadata | undefined {
  return metadataCache.get(file);
}

export const MAX_KLING_REFERENCE_VIDEOS = 1;
const KLING_MAX_BYTES = 200 * 1024 * 1024;
const KLING_MAX_PIXELS = 8_294_400;

/**
 * Kling's official reference video limits. Frame rate (24–60fps) is not
 * exposed by browser metadata, so the vendor remains the final check for it.
 */
export function klingReferenceVideoIssue(
  file: Pick<File, "name" | "type" | "size">,
  { duration, width, height }: MediaMetadata,
): string | undefined {
  if (!/^video\/(?:mp4|quicktime)$/.test(file.type) && !/\.(?:mp4|mov)$/i.test(file.name)) return "Kling 参考视频仅支持 MP4、MOV 格式";
  if (!file.size || file.size > KLING_MAX_BYTES) return "Kling 参考视频大小不能超过 200MB";
  if (!Number.isFinite(duration) || duration < 3 || duration > 15.5) return "Kling 参考视频时长需在 3–15.5 秒之间";
  if (!width || !height) return "无法读取参考视频分辨率，请更换文件";
  if (Math.min(width, height) < 700 || Math.max(width, height) > 4553) return "Kling 参考视频宽高需在 700–4553px 之间";
  if (width * height > KLING_MAX_PIXELS) return "Kling 参考视频总像素不能超过 8294400（约 3840×2160）";
  const ratio = width / height;
  if (ratio < 0.4 || ratio > 2) return "Kling 参考视频宽高比需在 0.4–2 之间";
  return undefined;
}

/** Re-checks already validated picks, e.g. after switching to a Kling model. */
export function klingReferenceVideosIssue(files: readonly File[]): string | undefined {
  if (files.length > MAX_KLING_REFERENCE_VIDEOS) return "Kling 最多添加 1 段参考视频";
  for (const file of files) {
    const metadata = cachedMediaMetadata(file);
    if (!metadata) return "无法读取参考视频分辨率，请更换文件";
    const issue = klingReferenceVideoIssue(file, metadata);
    if (issue) return issue;
  }
  return undefined;
}

export interface ImageSize { width: number; height: number }

const imageSizeCache = new WeakMap<File, ImageSize>();
export function readImageSize(file: File): Promise<ImageSize> {
  const cached = imageSizeCache.get(file);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
    const fail = () => {
      cleanup();
      // Cache the failure so a later Kling re-check reports it instead of "still checking".
      imageSizeCache.set(file, { width: 0, height: 0 });
      reject(new Error(`无法读取「${file.name}」的尺寸，请更换图片`));
    };
    const timer = window.setTimeout(fail, 10000);
    image.onload = () => {
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      cleanup();
      imageSizeCache.set(file, size);
      resolve(size);
    };
    image.onerror = fail;
    image.src = url;
  });
}

const KLING_MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** Kling's official image limits; both bounds are symmetric, so EXIF rotation cannot change the result. */
export function klingReferenceImageIssue(file: Pick<File, "name" | "type" | "size">, { width, height }: ImageSize): string | undefined {
  if (!/^image\/(?:jpeg|png)$/.test(file.type) && !/\.(?:jpe?g|png)$/i.test(file.name)) return "Kling 参考图仅支持 JPG、JPEG、PNG 格式";
  if (!file.size || file.size > KLING_MAX_IMAGE_BYTES) return "Kling 参考图大小不能超过 50MB";
  if (!width || !height) return "无法读取图片尺寸，请更换图片";
  if (Math.min(width, height) < 300) return "Kling 参考图宽高不能小于 300px";
  const ratio = width / height;
  if (ratio < 1 / 2.5 || ratio > 2.5) return "Kling 参考图宽高比需在 1:2.5–2.5:1 之间";
  return undefined;
}

export function checkKlingReferenceImage(file: File): Promise<string | undefined> {
  return readImageSize(file).then(
    (size) => klingReferenceImageIssue(file, size),
    (error: unknown) => error instanceof Error ? error.message : "无法读取图片尺寸，请更换图片",
  );
}

/** Synchronous send-time re-check from sizes measured on selection or model switch. */
export function klingReferenceImagesIssue(files: readonly File[]): string | undefined {
  for (const file of files) {
    const size = imageSizeCache.get(file);
    if (!size) return "正在检查图片尺寸，请稍后重试";
    const issue = klingReferenceImageIssue(file, size);
    if (issue) return issue;
  }
  return undefined;
}
