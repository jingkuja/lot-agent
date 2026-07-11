import type { Context, MiddlewareHandler } from "hono";

/**
 * Storage backend for {@link rateLimit}'s fixed-window counter. Production
 * uses an ioredis-backed implementation (see redis-rate-limit-store.ts);
 * tests inject an in-memory fake.
 */
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

export interface RateLimitOptions {
  store: RateLimitStore;
  /** Namespaces this limiter's counters, e.g. "rl:login" — combined with the
   * key from `keyFn` as `${prefix}:${key}`. */
  prefix: string;
  /** Max requests allowed within `windowMs`. */
  limit: number;
  windowMs: number;
  /** Derives the bucket identity from the request — typically the caller's
   * IP (public routes) or userId (authenticated routes). */
  keyFn: (c: Context) => string;
}

/**
 * Best-effort IP extraction: `x-forwarded-for`'s first (client-nearest) hop,
 * falling back to the raw socket address @hono/node-server exposes on
 * `c.env`, falling back to "unknown". Never throws — rate limiting must not
 * become a new failure mode for requests without a resolvable IP.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const remoteAddress = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming?.socket?.remoteAddress;
  return remoteAddress ?? "unknown";
}

/**
 * Fixed-window rate limit middleware: INCR the window counter, PEXPIRE it on
 * the first hit in the window, and reject with 429 once the count exceeds
 * `limit`. `Retry-After` is derived from PTTL (seconds, rounded up), falling
 * back to the full window when PTTL comes back unusable (e.g. -1/-2, or a
 * non-finite value from a flaky store).
 *
 * Rate limiting exists to blunt abuse, not to be a new single point of
 * failure: any store error (Redis down, timeout, ...) fails OPEN — the
 * request is admitted and the error is logged.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { store, prefix, limit, windowMs, keyFn } = opts;
  return async (c, next) => {
    const key = `${prefix}:${keyFn(c)}`;
    try {
      const count = await store.incr(key);
      if (count === 1) {
        await store.pexpire(key, windowMs);
      }
      if (count > limit) {
        let ttlMs: number;
        try {
          ttlMs = await store.pttl(key);
        } catch {
          ttlMs = windowMs;
        }
        if (!Number.isFinite(ttlMs) || ttlMs < 0) ttlMs = windowMs;
        const retryAfterSec = Math.ceil(ttlMs / 1000);
        c.header("Retry-After", String(retryAfterSec));
        return c.json({ error: "too many requests" }, 429);
      }
    } catch (err) {
      console.warn(`[rateLimit] store failure for prefix "${prefix}", failing open:`, err);
    }
    await next();
  };
}
