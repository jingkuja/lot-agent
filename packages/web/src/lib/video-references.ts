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

const durationCache = new WeakMap<File, number>();
export function readMediaDuration(file: File): Promise<number> {
  const cached = durationCache.get(file);
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
      const duration = element.duration;
      cleanup();
      durationCache.set(file, duration);
      resolve(duration);
    };
    element.onerror = fail;
    element.src = url;
  });
}
