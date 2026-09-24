import type { Pool } from "pg";
import { KnowledgeRepository } from "./repository.js";
/** Coordinate physical GC with uploads/archives, including the file-write → metadata-commit gap. */
export async function withKnowledgeStorageLease<T>(pool: Pool, owner: string, work: () => Promise<T>): Promise<T> {
  const id = await new KnowledgeRepository(pool).transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`rag-storage:${owner}`]);
    return (await client.query("INSERT INTO rag_storage_leases(owner_id) VALUES ($1) RETURNING id", [owner])).rows[0].id;
  });
  const timer = setInterval(() => { void pool.query("UPDATE rag_storage_leases SET expires_at=now()+interval '30 minutes' WHERE id=$1", [id]).catch(() => {}); }, 60000);
  timer.unref();
  try { return await work(); }
  finally { clearInterval(timer); await pool.query("DELETE FROM rag_storage_leases WHERE id=$1", [id]); }
}
