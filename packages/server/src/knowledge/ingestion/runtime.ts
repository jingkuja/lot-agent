import { waitForEmbeddingReceipts } from "./receipt-wait.js";
import { credentialFingerprint, reconcileEmbeddingReceipts } from "./receipts.js";
import { PreflightCache } from "./preflight-cache.js";
import type { DB } from "../../db/database.js";
import { UsageMeter } from "../../billing/meter.js";
import { TokenhubEmbeddingProvider } from "./embedding.js";
import type { IndexProfile } from "./profile.js";

const preflight = new PreflightCache<[{ data?: Array<{ id: string }> }, { data?: { quota_per_unit: number; usd_exchange_rate: number } }]>();

/** Resolve only the owner's credential. No platform/environment-key fallback. */
export function createUserEmbedder(db: DB, profile: IndexProfile, ownerId: string, taskId?: string, attribution?: { keyId?: string; application?: string }, options?: { receiptWaitMs?: number }) {
  return async (text: string, signal?: AbortSignal): Promise<{ vector: number[]; tokens: number }> => {
    if (signal?.aborted) throw new Error("INGESTION_CANCELLED");
    const apiKey = await db.getUserApiKey(ownerId, process.env.NEW_API_MANAGED_KEYS !== "0");
    if (!apiKey) throw new Error("EMBEDDING_CREDENTIAL_REQUIRED");
    const cacheKey = credentialFingerprint(ownerId, profile.providerRoute, apiKey);
    const headers = { Authorization: `Bearer ${apiKey}` };
    const get = async <T>(path: string): Promise<T> => {
      try {
        const response = await fetch(new URL(path, profile.providerRoute), { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
        if (!response.ok) throw Object.assign(new Error("EMBEDDING_PREFLIGHT_FAILED"), { status: response.status, stage: "capabilities", retryable: response.status === 429 || response.status >= 500 });
        return await response.json() as T;
      } catch (error) {
        if (error instanceof TypeError || error instanceof DOMException) throw Object.assign(new Error("EMBEDDING_PREFLIGHT_FAILED"), { retryable: !signal?.aborted });
        throw error;
      }
    };
    const [models, status] = await preflight.get(cacheKey, () => Promise.all([get<{ data?: Array<{ id: string }> }>(`${new URL(profile.providerRoute).pathname}/models`), get<{ data?: { quota_per_unit: number; usd_exchange_rate: number } }>("/api/status")]));
    if (!models.data?.some((model: { id: string }) => model.id === profile.modelId)) throw new Error("EMBEDDING_MODEL_UNAVAILABLE");
    const quotaUnit = status.data?.quota_per_unit; const exchangeRate = status.data?.usd_exchange_rate;
    if (typeof quotaUnit !== "number" || typeof exchangeRate !== "number" || !Number.isFinite(quotaUnit) || quotaUnit <= 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error("EMBEDDING_METER_UNAVAILABLE");
    const reconcile = () => reconcileEmbeddingReceipts(db, ownerId, profile.providerRoute, apiKey, signal);
    await waitForEmbeddingReceipts(reconcile, signal, options?.receiptWaitMs);
    // A conservative per-call admission budget, never used as the reported charge.
    if (!(await new UsageMeter(db, () => undefined).checkQuota(ownerId, 0.01 * Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 512)))).ok) throw new Error("EMBEDDING_QUOTA_EXCEEDED");
    let tokens = 0;
    const provider = new TokenhubEmbeddingProvider({ baseUrl: profile.providerRoute, apiKey, model: profile.modelId, dimensions: profile.dimensions,
      onUsage: async (count, requestId) => {
        tokens = count;
        await db.pool.query(`INSERT INTO rag_embedding_charges(owner_id,task_id,request_id,model_id,input_tokens,quota_per_unit,exchange_rate,knowledge_key_id,application,credential_fingerprint,provider_route)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(owner_id,credential_fingerprint,request_id) DO NOTHING`, [ownerId, taskId ?? null, requestId ?? null, profile.modelId, count, quotaUnit, exchangeRate, attribution?.keyId ?? null, attribution?.application ?? null, cacheKey, profile.providerRoute]);
        // Persist the receipt first; delayed gateway logs must not become zero-cost usage.
        // Receipt delays must not discard a paid vector. Persist it in the caller's
        // checkpoint; the next call reconciles before admitting another charge.
        try { await reconcile(); } catch { /* durable pending charge remains visible */ }
      },
    });
    const [vector] = await provider.embed([text], signal);
    return { vector, tokens };
  };
}
