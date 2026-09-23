import type { JobsOptions } from "bullmq";
import type { EnqueueOpts } from "@lot-agent/core";

export interface JobPublisher { add(name: string, data: { taskId: string }, opts: JobsOptions): Promise<unknown> }
/** Redis delivery of an already-persisted task. Never allocates another task ID. */
export async function publishPersistedJob(queue: JobPublisher, taskId: string, type: string, opts?: EnqueueOpts, extra?: JobsOptions): Promise<void> {
  await queue.add(type, { taskId }, { ...extra, jobId: taskId, priority: opts?.priority, delay: opts?.delayMs, attempts: opts?.maxAttempts });
}
