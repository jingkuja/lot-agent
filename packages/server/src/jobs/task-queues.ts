export const DEFAULT_TASK_QUEUE = "lot-tasks";
export const MARKETING_VIDEO_QUEUE = "lot-marketing-video";

/** Long marketing renders must not occupy the ordinary task worker. */
export function taskQueueName(type: string): string {
  return type === "marketing.video" ? MARKETING_VIDEO_QUEUE : DEFAULT_TASK_QUEUE;
}
