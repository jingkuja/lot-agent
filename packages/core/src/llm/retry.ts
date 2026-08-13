import type { ChatChunk } from "../types/index.js";

export interface LLMRetryConfig {
  /** Max retry attempts after the first. Default: 2. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  baseDelayMs?: number;
  /** Default: HTTP 429/5xx or common network-error message substrings. */
  isRetryable?(err: unknown): boolean;
  /** Reads a Retry-After-style delay off the error, if present. */
  retryAfterMs?(err: unknown): number | undefined;
  /** Aborts an in-progress backoff wait immediately (run cancellation), instead
   * of blocking the caller for up to the full delay. */
  signal?: AbortSignal;
}

/**
 * A tool-call turn that failed because the model emitted truncated or garbled
 * tool-call arguments. Vendors reject these with a 400-class error that says
 * things like "incomplete tool_call arguments" / "malformed arguments" and
 * often literally "Please retry the request" — it's a sampling artifact, so a
 * fresh generation usually produces valid JSON. Safe (and worthwhile) to redo,
 * unlike a genuinely bad request (unknown model, oversized context, …).
 */
export function isMalformedToolCallError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const mentionsToolCall = m.includes("tool_call") || m.includes("tool call");
  const isMalformed =
    m.includes("malformed") || m.includes("incomplete") || m.includes("invalid");
  return (
    (mentionsToolCall && isMalformed) ||
    m.includes("malformed arguments") ||
    isJsonDecodeError(m)
  );
}

/**
 * A Python `json.loads` decode error forwarded verbatim by the gateway
 * (DeepSeek/tokenhub) when the model's generated tool-call arguments aren't
 * valid JSON, e.g. `400 Expecting ',' delimiter: line 1 column 237 (char 236)`.
 * The message carries no "tool_call"/"malformed" keyword, only the decoder's
 * `line X column Y (char Z)` position signature plus an "Expecting …" /
 * "Unterminated string" phrase. Require BOTH so a plain 400 bad request (unknown
 * model, oversized context) is never mistaken for a retryable sampling artifact.
 */
function isJsonDecodeError(m: string): boolean {
  if (!/line \d+ column \d+ \(char \d+\)/.test(m)) return false;
  return (
    m.includes("expecting") ||
    m.includes("unterminated string") ||
    m.includes("delimiter")
  );
}

function defaultIsRetryable(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("network") ||
    isMalformedToolCallError(err)
  );
}

/**
 * Abortable backoff wait. If `signal` fires while sleeping, the timer is
 * cleared and the promise rejects immediately with the signal's abort reason
 * instead of blocking the caller for the remainder of the delay.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wraps a stream-creating function with retry. Only retries when the failing
 * attempt produced zero chunks — a fresh request is safe to redo; once any
 * chunk has already reached the caller, a later failure propagates as-is
 * instead of duplicating or discarding partial output.
 */
export async function* withLLMRetry(
  createStream: () => AsyncIterable<ChatChunk>,
  cfg: LLMRetryConfig = {}
): AsyncIterable<ChatChunk> {
  const maxRetries = cfg.maxRetries ?? 2;
  const baseDelayMs = cfg.baseDelayMs ?? 1000;
  const isRetryable = cfg.isRetryable ?? defaultIsRetryable;

  for (let attempt = 0; ; attempt++) {
    let yieldedAny = false;
    try {
      for await (const chunk of createStream()) {
        yieldedAny = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (yieldedAny || attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const retryAfter = cfg.retryAfterMs?.(err);
      const delay = retryAfter ?? baseDelayMs * 2 ** attempt + Math.random() * 300;
      await sleep(Math.min(delay, 10_000), cfg.signal);
    }
  }
}
