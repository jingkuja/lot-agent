import { publishPersistedJob } from "./persisted-job.js";
import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { EnqueueOpts, JobControl, JobQueue, JobRecord } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import { DEFAULT_TASK_QUEUE, MARKETING_VIDEO_QUEUE, taskQueueName } from "./task-queues.js";

/**
 * BullMQ-backed JobQueue implementation.
 * The DB is the source of truth for task state; BullMQ drives execution.
 *
 * v2: EnqueueOpts (priority / delay / attempts / idempotencyKey) map onto
 * BullMQ-native job options; the BullMQ job id is our task id so cancellation
 * can reach a queued job by id. Cancelling a job running in *this* process
 * aborts its `JobControl.signal`; BullMQ's own stalled-job detection covers
 * worker crashes.
 */
export class BullmqJobQueue implements JobQueue {
  private queues = new Map<string, Queue>();
  private workers = new Map<string, Worker>();
  private handlers = new Map<
    string,
    (job: JobRecord<unknown>, ctl: JobControl) => Promise<unknown>
  >();
  /** AbortControllers for jobs currently running in this process, keyed by task id. */
  private running = new Map<string, AbortController>();

  constructor(
    private readonly db: DB,
    private readonly connection: Redis
  ) {
    for (const name of [DEFAULT_TASK_QUEUE, MARKETING_VIDEO_QUEUE]) {
      this.queues.set(name, new Queue(name, { connection }));
    }
  }

  async enqueue<I>(
    type: string,
    input: I,
    userId: string,
    opts?: EnqueueOpts
  ): Promise<string> {
    const id = randomUUID();
    const name = taskQueueName(type);
    await this.db.createTask(id, type, input, userId, name);
    await publishPersistedJob(this.queues.get(name)!, id, type, opts);
    return id;
  }

  process<I, O>(
    type: string,
    handler: (job: JobRecord<I>, ctl: JobControl) => Promise<O>
  ): void {
    this.handlers.set(
      type,
      handler as (job: JobRecord<unknown>, ctl: JobControl) => Promise<unknown>
    );

    this.startWorker(taskQueueName(type));
    // Also drain legacy marketing entries from the old shared queue. This
    // worker only forwards those entries; the render runs on its own worker.
    if (type === "marketing.video") this.startWorker(DEFAULT_TASK_QUEUE);
  }

  private startWorker(name: string): void {
    if (!this.workers.has(name)) {
      const worker = new Worker(
        name,
        async (bullJob) => {
          const { taskId } = bullJob.data as { taskId: string };
          const jobType = bullJob.name;

          if (name === DEFAULT_TASK_QUEUE && jobType === "marketing.video") {
            // No DB claim and no business handler here. Adding with the same
            // ID is idempotent and never retries an existing failed target.
            const row = await this.db.getTask(taskId);
            if (row?.type === jobType && ["pending", "running"].includes(row.status)) {
              await publishPersistedJob(this.queues.get(MARKETING_VIDEO_QUEUE)!, taskId, jobType, { maxAttempts: 1 });
            }
            return;
          }

          const jobHandler = this.handlers.get(jobType);
          if (!jobHandler) {
            const errMsg = `No handler registered for job type: ${jobType}`;
            await this.db.setTaskError(taskId, errMsg);
            throw new Error(errMsg);
          }

          const attempts = bullJob.attemptsMade + 1;
          // A false claim means the task reached a terminal state (typically
          // cancelled while queued) before we got here — never run the handler.
          const claimed = await this.db.markTaskRunning(taskId, attempts);
          if (!claimed) return;
          const row = await this.db.getTask(taskId);
          if (!row) {
            throw new Error(`Task ${taskId} not found in DB`);
          }

          const jobRecord: JobRecord<unknown> = {
            id: row.id,
            type: row.type,
            status: "running",
            progress: row.progress,
            stage: row.stage ?? undefined,
            attempts,
            input: row.input,
            userId: row.user_id,
            createdAt: toIso(row.created_at),
            updatedAt: toIso(row.updated_at),
          };

          const controller = new AbortController();
          this.running.set(taskId, controller);
          const ctl: JobControl = {
            signal: controller.signal,
            // Renew the BullMQ lock so a long job isn't treated as stalled.
            heartbeat: () => {
              void bullJob.updateProgress(bullJob.progress ?? 0).catch(() => {});
            },
          };

          try {
            const output = await jobHandler(jobRecord, ctl);
            await this.db.setTaskResult(taskId, output);
            return output;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            await this.db.setTaskError(taskId, message);
            throw err; // rethrow so BullMQ marks job as failed
          } finally {
            this.running.delete(taskId);
          }
        },
        { connection: this.connection, concurrency: 1 }
      );
      this.workers.set(name, worker);
    }
  }

  /** Deliver a task committed atomically with its owning business record. */
  async deliverPersisted(id: string, type: string): Promise<void> {
    const name = taskQueueName(type);
    if (name === MARKETING_VIDEO_QUEUE) {
      const legacy = await this.queues.get(DEFAULT_TASK_QUEUE)!.getJob(id);
      if (legacy) {
        // An older deployed worker may still be finishing this task. Never
        // start a second render until it releases its BullMQ lock.
        if (await legacy.getState() === "active") return;
        // remove() fails if a worker claims it during this race. Let delivery
        // fail safely instead of publishing a duplicate to the new queue.
        await legacy.remove();
      }
    }
    const queue = this.queues.get(name)!;
    const previous = await queue.getJob(id);
    if (previous) {
      const state = await previous.getState();
      if (state === "failed" || state === "completed") await previous.retry(state);
    } else await publishPersistedJob(queue, id, type, { maxAttempts: 1 });
  }

  /** Do not revive a cancelled row while its previous worker is unwinding. */
  async canResumePersisted(id: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const previous = await queue.getJob(id);
      if (previous && !["failed", "completed"].includes(await previous.getState())) return false;
    }
    return true;
  }

  async get(id: string): Promise<JobRecord | null> {
    const row = await this.db.getTask(id);
    if (!row) return null;

    return {
      id: row.id,
      type: row.type,
      status: row.status as JobRecord["status"],
      progress: row.progress,
      stage: row.stage ?? undefined,
      attempts: row.attempts ?? 0,
      input: row.input,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
      userId: row.user_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async cancel(id: string): Promise<boolean> {
    const changed = await this.db.cancelTask(id);
    // Abort a handler running in this process.
    this.running.get(id)?.abort();
    // Remove a still-queued (waiting/delayed) job so it never starts. A job
    // already active is left to observe the aborted signal / DB status.
    for (const queue of this.queues.values()) {
      try {
        const bullJob = await queue.getJob(id);
        if (bullJob) {
          const state = await bullJob.getState();
          if (state === "waiting" || state === "delayed" || state === "prioritized") {
            await bullJob.remove();
          }
        }
      } catch {
        // best-effort — DB cancellation already recorded
      }
    }
    return changed;
  }

  async updateProgress(id: string, progress: number, stage?: string): Promise<void> {
    // #22: this used to also `this.connection.publish(...)` a progress event,
    // but nothing in the codebase ever subscribed to it — the web client
    // polls GET /api/tasks/:id every second instead. An authenticated event
    // stream is a real future feature, not this dead publish call, so it was
    // removed rather than kept "just in case".
    await this.db.updateTaskProgress(id, progress, stage);
  }

  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map(worker => worker.close()));
    this.workers.clear();
    await Promise.all([...this.queues.values()].map(queue => queue.close()));
    this.connection.disconnect();
  }
}

function toIso(v: string | Date): string {
  return typeof v === "string" ? v : new Date(v).toISOString();
}
