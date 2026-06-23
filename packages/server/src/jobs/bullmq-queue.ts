import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { JobQueue, JobRecord } from "@lot-agent/core";
import type { DB } from "../db/database.js";

const QUEUE_NAME = "lot-tasks";

/**
 * BullMQ-backed JobQueue implementation.
 * The DB is the source of truth for task state; BullMQ drives execution.
 */
export class BullmqJobQueue implements JobQueue {
  private queue: Queue;
  private worker: Worker | null = null;
  private handlers = new Map<string, (job: JobRecord<unknown>) => Promise<unknown>>();

  constructor(
    private readonly db: DB,
    private readonly connection: Redis
  ) {
    this.queue = new Queue(QUEUE_NAME, { connection });
  }

  async enqueue<I>(type: string, input: I, userId: string): Promise<string> {
    const id = randomUUID();
    await this.db.createTask(id, type, input, userId);
    await this.queue.add(type, { taskId: id });
    return id;
  }

  process<I, O>(type: string, handler: (job: JobRecord<I>) => Promise<O>): void {
    this.handlers.set(type, handler as (job: JobRecord<unknown>) => Promise<unknown>);

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

          await this.db.updateTaskStatus(taskId, "running");
          const row = await this.db.getTask(taskId);
          if (!row) {
            throw new Error(`Task ${taskId} not found in DB`);
          }

          const jobRecord: JobRecord<unknown> = {
            id: row.id,
            type: row.type,
            status: "running",
            progress: row.progress,
            input: row.input,
            userId: row.user_id,
            createdAt: typeof row.created_at === "string"
              ? row.created_at
              : new Date(row.created_at).toISOString(),
            updatedAt: typeof row.updated_at === "string"
              ? row.updated_at
              : new Date(row.updated_at).toISOString(),
          };

          try {
            const output = await jobHandler(jobRecord);
            await this.db.setTaskResult(taskId, output);
            return output;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            await this.db.setTaskError(taskId, message);
            throw err; // rethrow so BullMQ marks job as failed
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
      input: row.input,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
      userId: row.user_id,
      createdAt: typeof row.created_at === "string"
        ? row.created_at
        : new Date(row.created_at).toISOString(),
      updatedAt: typeof row.updated_at === "string"
        ? row.updated_at
        : new Date(row.updated_at).toISOString(),
    };
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    await this.db.updateTaskProgress(id, progress);
    // Optionally publish progress event (best-effort, non-fatal)
    try {
      await this.connection.publish(`task:${id}:progress`, String(progress));
    } catch {
      // Ignore publish failures
    }
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
