export const DEFAULT_TASK_QUEUE = "lot-tasks";
export const MARKETING_VIDEO_QUEUE = "lot-marketing-video";

export interface MarketingQueueLimits { concurrency: number; perUser: number; segments: number }
/** Renders per worker process, renders per user across all workers, and clips submitted at once within one render. */
export function marketingQueueLimits(env: NodeJS.ProcessEnv = process.env): MarketingQueueLimits {
  const read = (name: string, fallback: number, max: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer 1–${max}`);
    return n;
  };
  return { concurrency: read("MARKETING_VIDEO_CONCURRENCY", 2, 16), perUser: read("MARKETING_VIDEO_USER_CONCURRENCY", 1, 16),
    // A render has at most 15 clips, so more clip workers would never start.
    segments: read("MARKETING_VIDEO_SEGMENT_CONCURRENCY", 2, 15) };
}

/** Long marketing renders must not occupy the ordinary task worker. */
export function taskQueueName(type: string): string {
  return type === "marketing.video" ? MARKETING_VIDEO_QUEUE : DEFAULT_TASK_QUEUE;
}
