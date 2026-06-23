export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export interface JobRecord<I = unknown, O = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;       // 0-100
  input: I;
  output?: O;
  error?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobQueue {
  enqueue<I>(type: string, input: I, userId: string): Promise<string>; // returns jobId
  process<I, O>(type: string, handler: (job: JobRecord<I>) => Promise<O>): void;
  get(id: string): Promise<JobRecord | null>;
  updateProgress(id: string, progress: number): Promise<void>;
}
