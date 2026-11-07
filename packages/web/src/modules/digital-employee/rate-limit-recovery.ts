import { ApiClientError } from "../../api/client.js";

const MAX_RETRIES = 2;
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 60_000;

let readsResumeAt = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Waits out the request limit for reads, so a page fills in by itself instead of showing an error. Other reads
 * hold back during the wait. Changes are never resent: the person sees the message and decides.
 */
export async function recoverRead<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = readsResumeAt - Date.now();
    if (remaining > 0) await wait(remaining);
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.status !== 429 || attempt >= MAX_RETRIES) throw error;
      readsResumeAt = Date.now() + Math.min(error.retryAfterMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
    }
  }
}
