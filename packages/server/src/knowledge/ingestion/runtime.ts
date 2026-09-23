import type { DB } from "../../db/database.js";
import { UsageMeter } from "../../billing/meter.js";
import { TokenhubEmbeddingProvider } from "./embedding.js";
import type { IndexProfile } from "./profile.js";

/** Resolve only the owner's credential. No platform/environment-key fallback. */
export function createUserEmbedder(db: DB, profile: IndexProfile, ownerId: string, taskId?: string) {
  return async (text: string, signal?: AbortSignal): Promise<{ vector: number[]; tokens: number }> => {
    if (signal?.aborted) throw new Error("INGESTION_CANCELLED");
    const apiKey = await db.getUserApiKey(ownerId, process.env.NEW_API_MANAGED_KEYS !== "0");
    if (!apiKey) throw new Error("EMBEDDING_CREDENTIAL_REQUIRED");
    const headers = { Authorization: `Bearer ${apiKey}` };
    const get = async <T>(path: string, billing = false): Promise<T> => {
      const response = await fetch(new URL(path, profile.providerRoute), { headers, signal: signal && !billing ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("EMBEDDING_PREFLIGHT_FAILED");
      return response.json() as Promise<T>;
    };
    const [models, status] = await Promise.all([get<{ data?: Array<{ id: string }> }>(`${new URL(profile.providerRoute).pathname}/models`), get<{ data?: { quota_per_unit: number; usd_exchange_rate: number } }>("/api/status")]);
    if (!models.data?.some((model: { id: string }) => model.id === profile.modelId)) throw new Error("EMBEDDING_MODEL_UNAVAILABLE");
    const quotaUnit = status.data?.quota_per_unit; const exchangeRate = status.data?.usd_exchange_rate;
    if (typeof quotaUnit !== "number" || typeof exchangeRate !== "number" || !Number.isFinite(quotaUnit) || quotaUnit <= 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error("EMBEDDING_METER_UNAVAILABLE");
    const reconcile = async () => {
      const pending = await db.pool.query("SELECT * FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL ORDER BY created_at LIMIT 100", [ownerId]);
      if (!pending.rows.length) return true;
      const logs = await get<{ data?: Array<{ request_id: string; quota: number; model_name?: string }> }>("/api/log/token", true);
      for (const charge of pending.rows) {
        const log = logs.data?.find((entry: { request_id: string; quota: number; model_name?: string }) => entry.request_id === charge.request_id && entry.model_name === charge.model_id);
        if (!log || !Number.isFinite(log.quota) || log.quota < 0) continue;
        const cost = log.quota / charge.quota_per_unit * charge.exchange_rate;
        const client = await db.pool.connect();
        try {
          await client.query("BEGIN");
          const updated = await client.query("UPDATE rag_embedding_charges SET total_cost=$2 WHERE id=$1 AND total_cost IS NULL RETURNING id", [charge.id, cost]);
          if (updated.rows.length) await client.query(`INSERT INTO usage_logs(user_id,task_id,model_id,model_type,input_count,output_count,total_cost)
            VALUES ($1,$2,$3,'embedding',$4,0,$5)`, [ownerId, charge.task_id, charge.model_id, charge.input_tokens, cost]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      }
      return !(await db.pool.query("SELECT 1 FROM rag_embedding_charges WHERE owner_id=$1 AND total_cost IS NULL LIMIT 1", [ownerId])).rows.length;
    };
    if (!await reconcile()) throw new Error("EMBEDDING_BILLING_PENDING");
    // A conservative per-call admission budget, never used as the reported charge.
    if (!(await new UsageMeter(db, () => undefined).checkQuota(ownerId, 0.01 * Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 512)))).ok) throw new Error("EMBEDDING_QUOTA_EXCEEDED");
    let tokens = 0;
    const provider = new TokenhubEmbeddingProvider({ baseUrl: profile.providerRoute, apiKey, model: profile.modelId, dimensions: profile.dimensions,
      onUsage: async (count, requestId) => {
        tokens = count;
        await db.pool.query(`INSERT INTO rag_embedding_charges(owner_id,task_id,request_id,model_id,input_tokens,quota_per_unit,exchange_rate)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,request_id) DO NOTHING`, [ownerId, taskId ?? null, requestId ?? null, profile.modelId, count, quotaUnit, exchangeRate]);
        // Persist the receipt first; delayed gateway logs must not become zero-cost usage.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (await reconcile()) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("EMBEDDING_BILLING_PENDING");
      },
    });
    const [vector] = await provider.embed([text], signal);
    return { vector, tokens };
  };
}
