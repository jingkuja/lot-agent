import { randomUUID } from "node:crypto";
import type { JobQueue, JobRecord } from "./types.js";

/**
 * Pure in-memory job queue — no Redis required.
 * Intended for unit tests and local development.
 *
 * IMPORTANT: `process(type, handler)` MUST be called before `enqueue(type, ...)`.
 * If no handler is registered for a type at enqueue time, the job is stored
 * with status "pending" and will never be executed (document this at call sites).
 */
export class InMemoryJobQueue implements JobQueue {
  private records = new Map<string, JobRecord>();
  private handlers = new Map<string, (job: JobRecord<unknown>) => Promise<unknown>>();

  process<I, O>(type: string, handler: (job: JobRecord<I>) => Promise<O>): void {
    this.handlers.set(type, handler as (job: JobRecord<unknown>) => Promise<unknown>);
  }

  async enqueue<I>(type: string, input: I, userId: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord<I> = {
      id,
      type,
      status: "pending",
      progress: 0,
      input,
      userId,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record as JobRecord);

    const handler = this.handlers.get(type);
    if (handler) {
      // Run asynchronously (next microtask) so enqueue returns immediately
      Promise.resolve().then(async () => {
        await this._run(id, handler);
      });
    }
    // If no handler, job stays "pending" — caller must register handler first.

    return id;
  }

  private async _run(
    id: string,
    handler: (job: JobRecord<unknown>) => Promise<unknown>
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;

    this._update(id, { status: "running" });

    try {
      const output = await handler({ ...record, status: "running" });
      this._update(id, {
        status: "succeeded",
        progress: 100,
        output,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this._update(id, {
        status: "failed",
        error: message,
      });
    }
  }

  async get(id: string): Promise<JobRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    // Return a shallow clone so callers cannot mutate internal state
    return { ...record };
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    this._update(id, { progress });
  }

  private _update(id: string, patch: Partial<JobRecord>): void {
    const record = this.records.get(id);
    if (!record) return;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  }
}
