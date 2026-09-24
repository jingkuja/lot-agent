import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { publishPersistedJob } from "../../jobs/persisted-job.js";
import { KNOWLEDGE_JOB_TYPE } from "./config.js";

export async function assertKnowledgeJobsReady(pool: Pool): Promise<void> {
  const { rows } = await pool.query("SELECT version FROM schema_migrations WHERE version=29");
  if (!rows.length) throw new Error("Knowledge schema is not ready; start the server migrations first");
}

/** One short DB transaction per delivery. A send/commit gap is repaired with the same task ID. */
export async function dispatchKnowledgeOutbox(pool: Pool, queueName: string, send: (taskId: string) => Promise<void>, batch = 20): Promise<number> {
  let delivered = 0;
  for (let n = 0; n < batch; n++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT o.task_id FROM rag_outbox o JOIN rag_ingestion_runs r ON r.task_id=o.task_id
        JOIN tasks t ON t.id=r.task_id JOIN rag_items i ON i.owner_id=r.owner_id AND i.id=r.item_id
        WHERE o.queue_name=$1 AND o.available_at<=now() AND t.status IN ('pending','running')
          AND r.status IN ('pending','running') AND i.deleted_at IS NULL AND i.generation=r.generation AND i.pending_revision_id=r.revision_id
          AND (o.delivered_at IS NULL OR o.delivered_at<now()-interval '60 seconds')
          AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=now())
        ORDER BY o.available_at,o.task_id FOR UPDATE OF o SKIP LOCKED LIMIT 1`, [queueName]);
      if (!rows[0]) { await client.query("COMMIT"); break; }
      const id = rows[0].task_id;
      try {
        await send(id);
        await client.query("UPDATE rag_outbox SET delivered_at=now(),attempts=attempts+1,last_error_code=NULL,available_at=now()+interval '60 seconds' WHERE task_id=$1", [id]);
        delivered++;
      } catch {
        await client.query("UPDATE rag_outbox SET attempts=attempts+1,last_error_code='QUEUE_UNAVAILABLE',available_at=now()+make_interval(secs=>LEAST(60,power(2,LEAST(attempts,6))::int)) WHERE task_id=$1", [id]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  return delivered;
}

export async function deliverKnowledgeTask(queue: Queue, taskId: string) {
  const existing = await queue.getJob(taskId);
  if (existing) {
    const state = await existing.getState();
    if (["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(state)) return;
    // Only called for a still-live DB run. Redis may have retained a failed/no-op attempt.
    await existing.remove();
  }
  await publishPersistedJob(queue, taskId, KNOWLEDGE_JOB_TYPE, { maxAttempts: 3 }, {
    backoff: { type: "exponential", delay: 1000 }, removeOnComplete: { age: 86400 }, removeOnFail: { age: 86400 },
  });
}
