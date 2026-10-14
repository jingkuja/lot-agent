import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { AnalysisLease } from "@lot-agent/core/marketing-analysis";
import { ANALYSIS_JOB, ANALYSIS_QUEUE } from "./config.js";
import type { PgAnalysisStore } from "./repository.js";
import { AnalysisError } from "./errors.js";

export function analysisQueue(connection: ConnectionOptions) {
  const queue = new Queue(ANALYSIS_QUEUE, { connection });
  queue.on("error", () => {});
  return queue;
}
export async function deliverAnalysis(queue: Queue, id: string) {
  const existing = await queue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") await existing.retry(state);
  } else await queue.add(ANALYSIS_JOB, { taskId: id }, { jobId: id, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
}
export async function dispatchAnalyses(store: PgAnalysisStore, queue: Queue) {
  // PG is the outbox, including expired leases after a process crash.
  const rows = (await store.pool.query(`SELECT id FROM marketing_reference_analyses WHERE deleted_at IS NULL AND NOT cancel_requested
    AND (status='queued' OR (status='running' AND lease_until<now())) ORDER BY created_at LIMIT 100`)).rows;
  for (const row of rows) await deliverAnalysis(queue, row.id);
  await store.pool.query(`UPDATE marketing_reference_analyses a SET lease_token=NULL,lease_until=NULL,
    reserved_cost=(SELECT COALESCE(sum(s.reserved_cost),0) FROM marketing_analysis_steps s WHERE s.analysis_id=a.id
      AND (s.receipt IS NULL OR s.receipt->>'outcome'='request_unknown' OR s.receipt->'usage' IS NULL))
    WHERE a.cancel_requested AND a.lease_until<now()`);
}
export function createAnalysisConsumer(connection: ConnectionOptions, concurrency: number, store: PgAnalysisStore,
  run: (lease: AnalysisLease, signal: AbortSignal) => Promise<void>) {
  const running = new Map<string, AbortController>();
  const worker = new Worker(ANALYSIS_QUEUE, async job => {
    if (job.name !== ANALYSIS_JOB || typeof job.data.taskId !== "string") throw new Error("INVALID_ANALYSIS_JOB");
    const lease = await store.claim(job.data.taskId);
    if (!lease) return;
    const controller = new AbortController(); running.set(lease.id, controller);
    let beating = false;
    const timer = setInterval(() => {
      if (beating) return; beating = true;
      void store.heartbeat(lease).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort()).finally(() => { beating = false; });
    }, 2000);
    let code: string | undefined;
    try { await run(lease, controller.signal); }
    catch (error) { code = error instanceof AnalysisError ? error.code : controller.signal.aborted ? "PROCESS_CANCELLED" : "ANALYSIS_FAILED"; }
    finally {
      clearInterval(timer); running.delete(lease.id);
      // Losing DB access leaves the lease/intent for recovery, never replays a call.
      await store.finish(lease, code);
    }
  }, { connection, concurrency, maxStalledCount: 0 });
  worker.on("error", () => console.warn("[media-analysis] worker transport unavailable"));
  return { worker, async close() { for (const controller of running.values()) controller.abort(); await worker.close(); } };
}
