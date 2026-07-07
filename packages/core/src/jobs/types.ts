export type JobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRecord<I = unknown, O = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;       // 0-100
  /** Human-readable stage label for the current progress (e.g. "rendering"). */
  stage?: string;
  /** How many times the handler has been invoked (starts at 0, 1 on first run). */
  attempts: number;
  input: I;
  output?: O;
  error?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/** Options controlling how a job is scheduled and retried. */
export interface EnqueueOpts {
  /** Higher runs first when the backend supports it (BullMQ). */
  priority?: number;
  /** Defer execution by this many ms (the basis for scheduled publishing). */
  delayMs?: number;
  /** Max handler invocations before the job is marked failed. Default: 1. */
  maxAttempts?: number;
  /** Dedup key — re-enqueuing with the same key returns the existing job. */
  idempotencyKey?: string;
}

/** Handle passed to a job handler for cancellation and liveness. */
export interface JobControl {
  /** Aborts when the job is cancelled; handlers should stop promptly. */
  signal: AbortSignal;
  /** Signal progress/liveness so the backend does not consider the job stalled. */
  heartbeat(): void;
}

export interface JobQueue {
  enqueue<I>(
    type: string,
    input: I,
    userId: string,
    opts?: EnqueueOpts
  ): Promise<string>; // returns jobId
  process<I, O>(
    type: string,
    handler: (job: JobRecord<I>, ctl: JobControl) => Promise<O>
  ): void;
  get(id: string): Promise<JobRecord | null>;
  /** Cancel a job. pending → cancelled immediately; running → signals abort. Returns whether it was cancellable. */
  cancel(id: string): Promise<boolean>;
  updateProgress(id: string, progress: number, stage?: string): Promise<void>;
}
