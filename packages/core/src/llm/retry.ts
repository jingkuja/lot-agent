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
  return (mentionsToolCall && isMalformed) || m.includes("malformed arguments");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      await sleep(Math.min(delay, 10_000));
    }
  }
}
