import { publishPersistedJob } from "./persisted-job.js";
import { randomUUID } from "node:crypto";
import { DelayedError, Queue, Worker, type ConnectionOptions } from "bullmq";
import type Redis from "ioredis";
import type { EnqueueOpts, JobControl, JobQueue, JobRecord } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import { GENERATION_QUEUE_FAILED } from "../generation/errors.js";
import {
  COMIC_IMAGE_QUEUE, COMIC_RENDER_QUEUE, COMIC_VIDEO_QUEUE, comicQueueLimits, DEFAULT_TASK_QUEUE, isComicMediaTask,
  isIsolatedMediaQueue, MANAGED_TASK_QUEUES, MARKETING_VIDEO_QUEUE, marketingQueueLimits, taskQueueName,
  type ComicQueueLimits, type MarketingQueueLimits,
} from "./task-queues.js";

// A render that waits for the same owner's earlier render frees its slot for
// other users, then retries after this delay (plus jitter).
const OWNER_BUSY_DELAY_MS = 15_000;

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
    private readonly connection: Redis,
    private readonly marketingLimits: MarketingQueueLimits = marketingQueueLimits(),
    private readonly comicLimits: ComicQueueLimits = comicQueueLimits(),
  ) {
    for (const name of MANAGED_TASK_QUEUES) {
      this.queues.set(name, new Queue(name, { connection: bullConnection(connection) }));
    }
  }

  private queueConcurrency(name: string): number {
    if (name === MARKETING_VIDEO_QUEUE) return this.marketingLimits.concurrency;
    if (name === COMIC_IMAGE_QUEUE) return this.comicLimits.imageConcurrency;
    if (name === COMIC_VIDEO_QUEUE) return this.comicLimits.videoConcurrency;
    if (name === COMIC_RENDER_QUEUE) return this.comicLimits.renderConcurrency;
    return 1;
  }

  private queueOwnerLimit(name: string): number {
    if (name === MARKETING_VIDEO_QUEUE) return this.marketingLimits.perUser;
    if (name === COMIC_IMAGE_QUEUE) return this.comicLimits.imagePerUser;
    if (name === COMIC_VIDEO_QUEUE) return this.comicLimits.videoPerUser;
    if (name === COMIC_RENDER_QUEUE) return this.comicLimits.renderPerUser;
    return 1;
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
    // Also drain legacy entries from previously shared queues without claiming them.
    if (type === "marketing.video") this.startWorker(DEFAULT_TASK_QUEUE);
    if (isComicMediaTask(type)) this.startWorker(MARKETING_VIDEO_QUEUE);
  }

  private startWorker(name: string): void {
    if (!this.workers.has(name)) {
      const worker = new Worker(
        name,
        async (bullJob, token) => {
          const { taskId } = bullJob.data as { taskId: string };
          const jobType = bullJob.name;
          if (typeof taskId !== "string" || taskId !== bullJob.id) return;
          const persisted = await this.db.getTask(taskId);
          if (persisted?.type !== jobType || !["pending", "running"].includes(persisted.status)) return;

          if ((name === DEFAULT_TASK_QUEUE && jobType === "marketing.video")
            || (name === MARKETING_VIDEO_QUEUE && isComicMediaTask(jobType))) {
            // No DB claim and no business handler here. Adding with the same
            // ID is idempotent and never retries an existing failed target.
            await publishPersistedJob(this.queues.get(taskQueueName(jobType))!, taskId, jobType, { maxAttempts: 1 });
            return;
          }
          if (taskQueueName(jobType) !== name) return;

          const jobHandler = this.handlers.get(jobType);
          if (!jobHandler) {
            const errMsg = `No handler registered for job type: ${jobType}`;
            await this.db.setTaskError(taskId, errMsg);
            throw new Error(errMsg);
          }

          const attempts = bullJob.attemptsMade + 1;
          // A false claim means the task reached a terminal state (typically
          // cancelled while queued) before we got here — never run the handler.
          let claimed: boolean;
          if (isIsolatedMediaQueue(name)) {
            const live = () => queueDeadline(async () => (await this.queues.get(name)!.getActive(0, -1)).flatMap(job => job.id ? [job.id] : []));
            const claim = await this.db.claimTaskWithinOwnerLimit(taskId, attempts, persisted.user_id, live, this.queueOwnerLimit(name))
              .catch(() => "unavailable" as const);
            if (claim === "busy" || claim === "unavailable") {
              await bullJob.moveToDelayed(Date.now() + OWNER_BUSY_DELAY_MS + Math.floor(Math.random() * 5000), token);
              throw new DelayedError();
            }
            claimed = claim === "claimed";
            // Queue wait for P95 tracking: first run only, as resumes keep the original timestamp.
            if (claimed && bullJob.attemptsMade === 0) {
              console.info(name === MARKETING_VIDEO_QUEUE ? "[queue] marketing render started" : "[queue] comic task started",
                { queue: name, type: jobType, taskId, waitMs: Date.now() - bullJob.timestamp });
            }
          } else claimed = await this.db.markTaskRunning(taskId, attempts);
          if (!claimed) return;
          const row = await this.db.getTask(taskId);
          if (!row) {
            throw new Error(`Task ${taskId} not found in DB`);
          }
          if (!["pending", "running"].includes(row.status)) return;

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
          // Cancellation is durable in PG, including when the API and worker
          // are different processes. Losing that channel must stop new work.
          const observeCancellation = async () => {
            const status = await this.db.getTaskStatus(taskId);
            if (status !== "running") controller.abort();
          };
          const cancellationTimer = setInterval(() => {
            void observeCancellation().catch(() => controller.abort());
          }, 1000);
          cancellationTimer.unref();
          const ctl: JobControl = {
            signal: controller.signal,
            // Renew the BullMQ lock so a long job isn't treated as stalled.
            heartbeat: () => {
              void bullJob.updateProgress(bullJob.progress ?? 0).catch(() => {});
            },
          };

          try {
            await observeCancellation();
            if (controller.signal.aborted) return;
            const output = await jobHandler(jobRecord, ctl);
            await this.db.setTaskResult(taskId, output);
            return output;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const retry = !isIsolatedMediaQueue(taskQueueName(jobType)) && attempts < (bullJob.opts.attempts ?? 1)
              && (err as Error)?.name !== "UnrecoverableError";
            // Typed worker errors carry a cause code the UI can act on without parsing the message.
            const errorCode = typeof (err as { errorCode?: unknown })?.errorCode === "string" ? (err as { errorCode: string }).errorCode : undefined;
            if (retry) await this.db.markTaskRetryPending(taskId, attempts);
            else await this.db.setTaskError(taskId, message, errorCode);
            throw err; // rethrow so BullMQ marks job as failed
          } finally {
            clearInterval(cancellationTimer);
            this.running.delete(taskId);
          }
        },
        { connection: bullConnection(this.connection), concurrency: this.queueConcurrency(name) }
      );
      this.workers.set(name, worker);
    }
  }

  /** Detect missing jobs without confusing them with Redis errors. Reconcile persisted media deliveries and unpublished chat receipts. */
  async diagnosePending(staleMs: number): Promise<void> {
    let readable = this.connection.status === "ready";
    for (const row of await this.db.findStalePendingTasks(staleMs)) {
      let stage = "投递未完成，可恢复排队";
      try {
        if (!readable) throw new Error("queue unavailable");
        for (const queue of this.queues.values()) {
          // BullMQ's connection intentionally retries forever. Bound this
          // read-only diagnostic, so an outage still yields an unknown state.
          const state = await queueDeadline(async () => (await queue.getJob(row.id))?.getState());
          if (state) {
            if (["waiting", "delayed", "prioritized", "active", "waiting-children"].includes(state)) {
              stage = "等待队列处理";
              break;
            }
            // Comic media rows here have attempts=0, which an explicit resume sets before re-delivery.
            if (!isComicMediaTask(row.type) || !["failed", "completed"].includes(state)) stage = "队列状态待核实";
          }
        }
      } catch { readable = false; stage = "队列状态待核实"; }
      if (stage === "投递未完成，可恢复排队" && (row.type === "marketing.video" || isComicMediaTask(row.type))) {
        try {
          await queueDeadline(() => this.deliverPersisted(row.id, row.type));
          stage = "等待队列处理";
        } catch { readable = false; }
      }
      const input = row.input as { chatGeneration?: boolean; assistantMessageId?: string } | null;
      if (stage === "投递未完成，可恢复排队" && input?.chatGeneration === true && typeof input.assistantMessageId === "string") {
        await this.db.failUnpublishedChatGeneration(row.id, input.assistantMessageId, GENERATION_QUEUE_FAILED);
        continue;
      }
      await this.db.setPendingTaskDiagnostic(row.id, stage);
    }
  }

  /** Deliver a task committed atomically with its owning business record. */
  async deliverPersisted(id: string, type: string): Promise<void> {
    const row = await this.db.getTask(id);
    if (!row || row.type !== type || !["pending", "running"].includes(row.status)) return;
    const name = taskQueueName(type);
    const legacyQueueName = name === MARKETING_VIDEO_QUEUE ? DEFAULT_TASK_QUEUE : isComicMediaTask(type) ? MARKETING_VIDEO_QUEUE : null;
    if (legacyQueueName) {
      const legacy = await this.queues.get(legacyQueueName)!.getJob(id);
      if (legacy) {
        // An older deployed worker may still be finishing this task. Never
        // start a second run until it releases its BullMQ lock.
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

  /** Publish a newly committed task once, without reviving terminal queue entries. */
  publishNewTask(id: string, type: string): Promise<void> {
    return queueDeadline(() => publishPersistedJob(this.queues.get(taskQueueName(type))!, id, type, { maxAttempts: 1 }));
  }

  resumePersisted(id: string, type: string): Promise<void> {
    return queueDeadline(() => this.deliverPersisted(id, type));
  }

  /** Do not revive a cancelled row while its previous worker is unwinding. */
  async canResumePersisted(id: string): Promise<boolean> {
    if (this.connection.status !== "ready") return false;
    try {
      for (const queue of this.queues.values()) {
        const state = await queueDeadline(async () => (await queue.getJob(id))?.getState());
        if (state && !["failed", "completed"].includes(state)) return false;
      }
      return true;
    } catch { return false; }
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
    await this.stopCancelled(id);
    return changed;
  }

  /** The caller has already made cancellation durable with its business record locked. */
  async stopCancelled(id: string): Promise<void> {
    // Abort a handler running in this process.
    this.running.get(id)?.abort();
    if (this.connection.status !== "ready") return;
    // Remove a still-queued (waiting/delayed) job so it never starts. A job
    // already active is left to observe the aborted signal / DB status.
    for (const queue of this.queues.values()) {
      try {
        await queueDeadline(async () => {
          const bullJob = await queue.getJob(id);
          if (bullJob) {
            const state = await bullJob.getState();
            if (state === "waiting" || state === "delayed" || state === "prioritized") {
              await bullJob.remove();
            }
          }
        });
      } catch {
        // best-effort — DB cancellation already recorded
      }
    }
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

/** BullMQ bundles its own ioredis typings; the client is the same library at runtime. */
const bullConnection = (connection: Redis) => connection as unknown as ConnectionOptions;

async function queueDeadline<T>(read: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("queue unavailable")), 2000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

function toIso(v: string | Date): string {
  return typeof v === "string" ? v : new Date(v).toISOString();
}
