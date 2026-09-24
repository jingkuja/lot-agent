import { setTimeout as delay } from "node:timers/promises";
/** Gateway log visibility is eventually consistent. Waiting does not issue another
 * embedding request or spend the ingestion run's retry budget on each chunk. */
export async function waitForEmbeddingReceipts(reconcile: () => Promise<boolean>, signal?: AbortSignal, waitMs = 30000) {
  const deadline = Date.now() + waitMs;
  while (!await reconcile()) {
    if (signal?.aborted) throw new Error("INGESTION_CANCELLED");
    if (Date.now() >= deadline) throw Object.assign(new Error("EMBEDDING_BILLING_PENDING"), { retryable: true });
    await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}
