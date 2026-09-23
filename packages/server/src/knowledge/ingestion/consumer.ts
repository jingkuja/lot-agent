import { Worker, type ConnectionOptions } from "bullmq";
import { KnowledgeJobs, type IngestionLease } from "./jobs.js";
import { KNOWLEDGE_JOB_TYPE } from "./config.js";

export interface KnowledgeProcessor {
  (lease: IngestionLease, signal: AbortSignal): Promise<void>;
}
/** Isolated queue consumer; does not register with or drain lot-tasks. */
export function createKnowledgeConsumer(connection: ConnectionOptions, queueName: string, concurrency: number, jobs: KnowledgeJobs, process: KnowledgeProcessor) {
  return new Worker(queueName, async (job) => {
    if (job.name !== KNOWLEDGE_JOB_TYPE) throw new Error("INVALID_KNOWLEDGE_JOB");
    const lease = await jobs.claim(job.id!, queueName);
    if (!lease) return;
    const controller = new AbortController(); let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return; renewing = true;
      try { if (!await jobs.heartbeat(lease)) controller.abort(); }
      catch { controller.abort(); }
      finally { renewing = false; }
    }, 15000);
    heartbeat.unref();
    try {
      if (lease.attempts > 3) { await jobs.fail(lease, "ATTEMPTS_EXHAUSTED", false); return; }
      await process(lease, controller.signal);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "INGESTION_FAILED";
      const code = /^[A-Z_]{1,64}$/.test(raw) ? raw : "INGESTION_FAILED";
      const retry = Boolean((error as { retryable?: boolean })?.retryable) && lease.attempts < 3;
      const changed = await jobs.fail(lease, code, retry);
      if (changed && retry) throw new Error(code);
    } finally { clearInterval(heartbeat); controller.abort(); }
  }, { connection, concurrency, lockDuration: 120000 });
}
