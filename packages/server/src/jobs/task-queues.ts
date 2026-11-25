export const DEFAULT_TASK_QUEUE = "lot-tasks";
export const MARKETING_VIDEO_QUEUE = "lot-marketing-video";
export const COMIC_IMAGE_QUEUE = "lot-comic-image";
export const COMIC_VIDEO_QUEUE = "lot-comic-video";
export const COMIC_RENDER_QUEUE = "lot-comic-render";
export const ISOLATED_MEDIA_QUEUES = [
  MARKETING_VIDEO_QUEUE,
  COMIC_IMAGE_QUEUE,
  COMIC_VIDEO_QUEUE,
  COMIC_RENDER_QUEUE,
] as const;
export const MANAGED_TASK_QUEUES = [DEFAULT_TASK_QUEUE, ...ISOLATED_MEDIA_QUEUES] as const;
export const isIsolatedMediaQueue = (name: string): boolean =>
  (ISOLATED_MEDIA_QUEUES as readonly string[]).includes(name);

export interface MarketingQueueLimits { concurrency: number; perUser: number; segments: number }
export interface ComicQueueLimits {
  imageConcurrency: number;
  imagePerUser: number;
  videoConcurrency: number;
  videoPerUser: number;
  renderConcurrency: number;
  renderPerUser: number;
}

function readQueueLimit(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const n = Number(env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer 1–${max}`);
  return n;
}

/** Renders per worker process, renders per user across all workers, and clips submitted at once within one render. */
export function marketingQueueLimits(env: NodeJS.ProcessEnv = process.env): MarketingQueueLimits {
  return {
    concurrency: readQueueLimit(env, "MARKETING_VIDEO_CONCURRENCY", 2, 16),
    perUser: readQueueLimit(env, "MARKETING_VIDEO_USER_CONCURRENCY", 1, 16),
    // A render has at most 15 clips, so more clip workers would never start. Four clips cover a
    // 60-second video in one round.
    segments: readQueueLimit(env, "MARKETING_VIDEO_SEGMENT_CONCURRENCY", 4, 15),
  };
}

/** Per-node and per-owner limits for isolated comic-drama image, video, and FFmpeg render queues. */
export function comicQueueLimits(env: NodeJS.ProcessEnv = process.env): ComicQueueLimits {
  return {
    imageConcurrency: readQueueLimit(env, "COMIC_IMAGE_CONCURRENCY", 2, 16),
    imagePerUser: readQueueLimit(env, "COMIC_IMAGE_USER_CONCURRENCY", 1, 16),
    videoConcurrency: readQueueLimit(env, "COMIC_VIDEO_CONCURRENCY", 2, 16),
    videoPerUser: readQueueLimit(env, "COMIC_VIDEO_USER_CONCURRENCY", 1, 16),
    // FFmpeg 1080p/4K composition is CPU- and memory-intensive; keep per-node concurrency tightly capped (1–2 recommended).
    renderConcurrency: readQueueLimit(env, "COMIC_RENDER_CONCURRENCY", 1, 4),
    renderPerUser: readQueueLimit(env, "COMIC_RENDER_USER_CONCURRENCY", 1, 4),
  };
}

/** Each render (and digital presenter) holds one worker connection for its advisory lock for the whole
 * job, and its clips need short ones beside it. Returns the startup error when the pool is too small. */
export function marketingPoolIssue(limits: Pick<MarketingQueueLimits, "concurrency">, poolMax: number): string {
  const needed = limits.concurrency * 2 + 2;
  return poolMax >= needed ? ""
    : `PG_POOL_MAX (${poolMax}) must be at least ${needed} for MARKETING_VIDEO_CONCURRENCY=${limits.concurrency}: each render holds one connection for its lock.`;
}

/** Checks that the worker PG pool can sustain concurrent marketing and isolated comic media queues together. */
export function workerPoolIssue(
  marketing: Pick<MarketingQueueLimits, "concurrency">,
  comic: Pick<ComicQueueLimits, "imageConcurrency" | "videoConcurrency" | "renderConcurrency">,
  poolMax: number,
): string {
  const slots = marketing.concurrency + comic.imageConcurrency + comic.videoConcurrency + comic.renderConcurrency;
  const needed = slots * 2 + 2;
  return poolMax >= needed ? ""
    : `PG_POOL_MAX (${poolMax}) must be at least ${needed} for total media concurrency=${slots}: each active media job holds a lock connection.`;
}

export const DIGITAL_PRESENTER_TASK = "digital-presenter.video";
export const COMIC_IMAGE_TASK = "comic-drama.image";
export const COMIC_VIDEO_TASK = "comic-drama.video";
export const COMIC_RENDER_TASK = "comic-drama.render";
export const isComicMediaTask = (type: string) => type === COMIC_IMAGE_TASK || type === COMIC_VIDEO_TASK || type === COMIC_RENDER_TASK;
/** Long media generation and FFmpeg renders run in dedicated isolated queues so heavy comic jobs never block marketing or image tasks. */
export function taskQueueName(type: string): string {
  if (type === "marketing.video" || type === DIGITAL_PRESENTER_TASK) return MARKETING_VIDEO_QUEUE;
  if (type === COMIC_IMAGE_TASK) return COMIC_IMAGE_QUEUE;
  if (type === COMIC_VIDEO_TASK) return COMIC_VIDEO_QUEUE;
  if (type === COMIC_RENDER_TASK) return COMIC_RENDER_QUEUE;
  return DEFAULT_TASK_QUEUE;
}
