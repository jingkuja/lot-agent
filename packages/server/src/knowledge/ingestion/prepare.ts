import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { KNOWLEDGE_JOB_TYPE } from "./config.js";

/** Caller holds the item lock; all four records commit or roll back together. */
export async function prepareIngestion(client: PoolClient, input: {
  ownerId: string; itemId: string; revisionId: string; generation: number; queueName: string;
}): Promise<string> {
  if (input.queueName === "lot-tasks" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.queueName)) throw new Error("Invalid knowledge queue");
  const id = randomUUID();
  const { ownerId, itemId, revisionId, generation, queueName } = input;
  await client.query(`INSERT INTO tasks(id,type,input,user_id,queue_name) VALUES ($1,$2,$3,$4,$5)`,
    [id, KNOWLEDGE_JOB_TYPE, JSON.stringify({ itemId, revisionId, generation }), ownerId, queueName]);
  await client.query(`INSERT INTO rag_ingestion_runs(task_id,owner_id,item_id,revision_id,generation,artifact,artifact_version)
    VALUES ($1,$2,$3,$4,$5,
      (SELECT artifact FROM rag_ingestion_runs WHERE owner_id=$2 AND revision_id=$4 AND artifact IS NOT NULL ORDER BY generation DESC LIMIT 1),
      (SELECT artifact_version FROM rag_ingestion_runs WHERE owner_id=$2 AND revision_id=$4 AND artifact IS NOT NULL ORDER BY generation DESC LIMIT 1))`, [id, ownerId, itemId, revisionId, generation]);
  await client.query("INSERT INTO rag_outbox(task_id,queue_name) VALUES ($1,$2)", [id, queueName]);
  return id;
}

/** Called while holding the item lock, before advancing its generation. */
export async function supersedeIngestion(client: PoolClient, owner: string, item: string) {
  await client.query(`UPDATE tasks SET status='cancelled',updated_at=now() WHERE id IN
    (SELECT task_id FROM rag_ingestion_runs WHERE owner_id=$1 AND item_id=$2 AND status IN ('pending','running'))
    AND status IN ('pending','running')`, [owner, item]);
  await client.query("UPDATE rag_ingestion_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE owner_id=$1 AND item_id=$2 AND status IN ('pending','running')", [owner, item]);
}
