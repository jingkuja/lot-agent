import { createHash } from "node:crypto";
import type { DB } from "../../db/database.js";
import { PreflightCache } from "./preflight-cache.js";
const receipts = new PreflightCache<{ data?: Array<{ request_id: string; quota: number; model_name?: string }> }>(500);
export const credentialFingerprint = (owner: string, route: string, key: string) => createHash("sha256").update(`${owner}\0${route}\0${key}`).digest("hex");

/** Only gateway receipts finalize costs. Missing/expired receipts remain pending. */
export async function reconcileEmbeddingReceipts(db: DB, owner: string, route: string, key: string, signal?: AbortSignal, includeLegacy = false) {
  const fingerprint = credentialFingerprint(owner, route, key);
  const pending = await db.pool.query(`SELECT * FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL
    AND (credential_fingerprint=$2 OR ($3 AND credential_fingerprint IS NULL)) ORDER BY created_at LIMIT 100`, [owner, fingerprint, includeLegacy]);
  if (!pending.rows.length) return true;
  const logs = await receipts.get(fingerprint, async () => {
    try {
      const response = await fetch(new URL("/api/log/token", route), { headers: { Authorization: `Bearer ${key}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (!response.ok) throw Object.assign(new Error("EMBEDDING_RECEIPT_UNAVAILABLE"), { retryable: response.status === 429 || response.status >= 500 });
      const body = await response.json() as { data?: Array<{ request_id: string; quota: number; model_name?: string }> };
      if (!body || !Array.isArray(body.data)) throw Object.assign(new Error("EMBEDDING_RECEIPT_UNAVAILABLE"), { retryable: true });
      return { data: body.data.filter((entry) => entry && typeof entry.request_id === "string" && typeof entry.model_name === "string" && Number.isFinite(entry.quota)) };
    } catch (error) {
      if (error instanceof TypeError || error instanceof DOMException) throw Object.assign(new Error("EMBEDDING_RECEIPT_UNAVAILABLE"), { retryable: !signal?.aborted });
      throw error;
    }
  });
  for (const charge of pending.rows) {
    if (!charge.request_id) continue;
    const log = logs.data?.find((entry) => entry.request_id === charge.request_id && entry.model_name === charge.model_id);
    if (!log || !Number.isFinite(log.quota) || log.quota < 0) continue;
    const cost = log.quota / charge.quota_per_unit * charge.exchange_rate;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query("UPDATE rag_embedding_charges SET total_cost=$2 WHERE id=$1 AND total_cost IS NULL RETURNING id", [charge.id, cost]);
      if (updated.rows.length) await client.query(`INSERT INTO usage_logs(user_id,task_id,model_id,model_type,input_count,output_count,total_cost,knowledge_key_id,application)
        VALUES ($1,$2,$3,'embedding',$4,0,$5,$6,$7)`, [owner, charge.task_id, charge.model_id, charge.input_tokens, cost, charge.knowledge_key_id, charge.application]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  return !(await db.pool.query(`SELECT 1 FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL
    AND (credential_fingerprint=$2 OR ($3 AND credential_fingerprint IS NULL)) LIMIT 1`, [owner, fingerprint, includeLegacy])).rows.length;
}

/** Reconcile even after the final chunk/query. Read existing user credentials only;
 * removed credentials stay pending for explicit operator reconciliation. */
export async function reconcilePendingEmbeddingReceipts(db: DB, signal?: AbortSignal) {
  const groups = (await db.pool.query(`SELECT owner_id,provider_route,credential_fingerprint FROM rag_embedding_charges
    WHERE total_cost IS NULL AND credential_fingerprint IS NOT NULL GROUP BY owner_id,provider_route,credential_fingerprint`)).rows;
  const credentials = new Map<string, string[]>();
  for (const group of groups) {
    if (signal?.aborted) return;
    try {
      if (!credentials.has(group.owner_id)) {
        const [active, stored, runtime] = await Promise.all([db.getUserApiKey(group.owner_id, process.env.NEW_API_MANAGED_KEYS !== "0"), db.getUserApiKeys(group.owner_id), db.getUserRuntimeApiKeys(group.owner_id, false)]);
        credentials.set(group.owner_id, [...new Set([active, ...stored.map((k) => k.apiKey), ...runtime.map((k) => k.apiKey)].filter((k): k is string => !!k))]);
      }
      const key = credentials.get(group.owner_id)!.find((key) => credentialFingerprint(group.owner_id, group.provider_route, key) === group.credential_fingerprint);
      if (key) await reconcileEmbeddingReceipts(db, group.owner_id, group.provider_route, key, signal);
    } catch { /* Do not log credentials or vendor responses. Retry on the next sweep. */ }
  }
}
