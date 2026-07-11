import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { EnqueueOpts, JobControl, JobQueue, JobRecord } from "@lot-agent/core";
import type { DB } from "../db/database.js";

const QUEUE_NAME = "lot-tasks";

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
  private queue: Queue;
  private worker: Worker | null = null;
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
    this.queue = new Queue(QUEUE_NAME, { connection });
  }

  async enqueue<I>(
    type: string,
    input: I,
    userId: string,
    opts?: EnqueueOpts
  ): Promise<string> {
    const id = randomUUID();
    await this.db.createTask(id, type, input, userId);
    await this.queue.add(
      type,
      { taskId: id },
      {
        // Use our task id as the BullMQ job id so cancel() can target it, and
        // so a duplicate enqueue with the same id is a no-op on the queue side.
        jobId: id,
        priority: opts?.priority,
        delay: opts?.delayMs,
        attempts: opts?.maxAttempts,
      }
    );
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

    // Lazily create the single Worker on first process() call
    if (!this.worker) {
      this.worker = new Worker(
        QUEUE_NAME,
        async (bullJob) => {
          const { taskId } = bullJob.data as { taskId: string };
          const jobType = bullJob.name;

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
        { connection: this.connection }
      );
    }
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
    try {
      const bullJob = await this.queue.getJob(id);
      if (bullJob) {
        const state = await bullJob.getState();
        if (state === "waiting" || state === "delayed" || state === "prioritized") {
          await bullJob.remove();
        }
      }
    } catch {
      // best-effort — DB cancellation already recorded
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
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    await this.queue.close();
    this.connection.disconnect();
  }
}

function toIso(v: string | Date): string {
  return typeof v === "string" ? v : new Date(v).toISOString();
}
