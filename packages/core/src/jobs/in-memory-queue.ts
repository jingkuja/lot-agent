import { randomUUID } from "node:crypto";
import type {
  EnqueueOpts,
  JobControl,
  JobQueue,
  JobRecord,
} from "./types.js";

type Handler = (
  job: JobRecord<unknown>,
  ctl: JobControl
) => Promise<unknown>;

/** Internal per-job bookkeeping not exposed on the public JobRecord. */
interface JobMeta {
  maxAttempts: number;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  /** Set when cancel() is requested while the job is running. */
  cancelRequested?: boolean;
}

/**
 * Pure in-memory job queue — no Redis required. Intended for unit tests and
 * local development, and the contract baseline for real backends (BullMQ).
 *
 * v2 semantics: delayed execution, cancellation (pending + running), bounded
 * retries (`maxAttempts`), idempotency keys, per-job `JobControl` (abort signal
 * + heartbeat). `priority` is accepted for API parity but has no effect here
 * (jobs run immediately on their own microtask); real ordering is a BullMQ concern.
 *
 * IMPORTANT: `process(type, handler)` MUST be called before `enqueue(type, ...)`.
 * If no handler is registered at enqueue time, the job stays "pending" forever.
 */
export class InMemoryJobQueue implements JobQueue {
  private records = new Map<string, JobRecord>();
  private meta = new Map<string, JobMeta>();
  private handlers = new Map<string, Handler>();
  private idempotency = new Map<string, string>();

  process<I, O>(
    type: string,
    handler: (job: JobRecord<I>, ctl: JobControl) => Promise<O>
  ): void {
    this.handlers.set(type, handler as Handler);
  }

  async enqueue<I>(
    type: string,
    input: I,
    userId: string,
    opts?: EnqueueOpts
  ): Promise<string> {
    // Idempotency: a repeat with the same key returns the existing job.
    if (opts?.idempotencyKey) {
      const existing = this.idempotency.get(opts.idempotencyKey);
      if (existing) return existing;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord<I> = {
      id,
      type,
      status: "pending",
      progress: 0,
      attempts: 0,
      input,
      userId,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record as JobRecord);
    this.meta.set(id, { maxAttempts: Math.max(1, opts?.maxAttempts ?? 1) });
    if (opts?.idempotencyKey) this.idempotency.set(opts.idempotencyKey, id);

    const handler = this.handlers.get(type);
    if (handler) {
      const start = () => {
        void this._run(id, handler);
      };
      if (opts?.delayMs && opts.delayMs > 0) {
        const timer = setTimeout(start, opts.delayMs);
        (timer as { unref?: () => void }).unref?.();
        this.meta.get(id)!.timer = timer;
      } else {
        // Next microtask so enqueue returns immediately.
        Promise.resolve().then(start);
      }
    }
    // If no handler, job stays "pending" — caller must register handler first.

    return id;
  }

  private async _run(id: string, handler: Handler): Promise<void> {
    const record = this.records.get(id);
    const meta = this.meta.get(id);
    if (!record || !meta) return;
    // A cancel that landed while the job was still pending wins.
    if (record.status === "cancelled" || meta.cancelRequested) {
      this._update(id, { status: "cancelled" });
      return;
    }

    for (let attempt = 1; attempt <= meta.maxAttempts; attempt++) {
      if (meta.cancelRequested) {
        this._update(id, { status: "cancelled" });
        return;
      }
      const controller = new AbortController();
      meta.controller = controller;
      this._update(id, { status: "running", attempts: attempt });

      const ctl: JobControl = {
        signal: controller.signal,
        heartbeat: () => this._update(id, {}),
      };

      try {
        const output = await handler({ ...this.records.get(id)! }, ctl);
        if (meta.cancelRequested) {
          this._update(id, { status: "cancelled" });
          return;
        }
        this._update(id, { status: "succeeded", progress: 100, output });
        return;
      } catch (err: unknown) {
        if (meta.cancelRequested || controller.signal.aborted) {
          this._update(id, { status: "cancelled" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= meta.maxAttempts) {
          this._update(id, { status: "failed", error: message });
          return;
        }
        // otherwise loop and retry
      }
    }
  }

  async get(id: string): Promise<JobRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    // Return a shallow clone so callers cannot mutate internal state.
    return { ...record };
  }

  async cancel(id: string): Promise<boolean> {
    const record = this.records.get(id);
    const meta = this.meta.get(id);
    if (!record || !meta) return false;
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") {
      return false;
    }
    meta.cancelRequested = true;
    if (record.status === "pending") {
      // Not started yet (possibly still waiting on its delay timer) — cancel outright.
      if (meta.timer) clearTimeout(meta.timer);
      this._update(id, { status: "cancelled" });
      return true;
    }
    // Running — signal the handler; finalization to "cancelled" happens in _run.
    meta.controller?.abort();
    return true;
  }

  async updateProgress(id: string, progress: number, stage?: string): Promise<void> {
    this._update(id, stage === undefined ? { progress } : { progress, stage });
  }

  private _update(id: string, patch: Partial<JobRecord>): void {
    const record = this.records.get(id);
    if (!record) return;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  }
}
