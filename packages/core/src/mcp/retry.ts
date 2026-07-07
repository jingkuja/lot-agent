export interface RetryAsyncOptions {
  /** Total attempts including the first. Default: 3. */
  attempts?: number;
  /** Base delay for exponential backoff. Default: 500ms. */
  baseDelayMs?: number;
  /** Injectable sleep (tests pass a no-op). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry with the (1-based) attempt just failed. */
  onRetry?: (attempt: number, err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an async function with bounded exponential-backoff retries. Generic
 * counterpart to the stream-oriented `withLLMRetry`; used for MCP reconnects.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: RetryAsyncOptions = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      opts.onRetry?.(attempt, err);
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100;
      await sleep(Math.min(delay, 10_000));
    }
  }
  throw lastErr;
}
