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
    // A render has at most 15 clips, so more clip workers would never start. Four clips cover a
    // 60-second video in one round.
    segments: read("MARKETING_VIDEO_SEGMENT_CONCURRENCY", 4, 15) };
}

/** Each render (and digital presenter) holds one worker connection for its advisory lock for the whole
 * job, and its clips need short ones beside it. Returns the startup error when the pool is too small. */
export function marketingPoolIssue(limits: Pick<MarketingQueueLimits, "concurrency">, poolMax: number): string {
  const needed = limits.concurrency * 2 + 2;
  return poolMax >= needed ? ""
    : `PG_POOL_MAX (${poolMax}) must be at least ${needed} for MARKETING_VIDEO_CONCURRENCY=${limits.concurrency}: each render holds one connection for its lock.`;
}

export const DIGITAL_PRESENTER_TASK = "digital-presenter.video";
/** Long renders (marketing videos and digital presenters) must not occupy the ordinary task worker. */
export function taskQueueName(type: string): string {
  return type === "marketing.video" || type === DIGITAL_PRESENTER_TASK ? MARKETING_VIDEO_QUEUE : DEFAULT_TASK_QUEUE;
}
