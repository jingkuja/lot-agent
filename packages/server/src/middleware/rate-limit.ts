import { isIP } from "node:net";
import { isPrivateAddress } from "@lot-agent/core";
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
  /** Error text of a refused request; defaults to "too many requests". */
  message?: string;
}

/**
 * The address a rate limit counts. `x-forwarded-for` is believed only when the connection
 * comes from a private address, meaning nginx on this host or Docker network, and only its
 * last entry, the one that proxy wrote. Anything earlier is whatever the client sent.
 * A CDN or load balancer in front of nginx would need nginx's real_ip module.
 */
export function clientIp(c: Context): string {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  if (!socket) return "unknown";
  const peer = socket.replace(/^::ffff:/i, "");
  const family = isIP(peer);
  if (!family || !isPrivateAddress(peer, family)) return peer;
  const hop = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim().replace(/^::ffff:/i, "");
  return hop && isIP(hop) ? hop : peer;
}

/**
 * Fixed-window rate limit middleware: INCR the window counter, PEXPIRE it on
 * the first hit in the window, and reject with 429 once the count exceeds
 * `limit`. `Retry-After` is derived from PTTL (seconds, rounded up), falling
 * back to the full window when PTTL comes back unusable (-2 key missing, or a
 * non-finite value from a flaky store). PTTL of -1 (key exists with no expiry,
 * i.e. the first hit's PEXPIRE failed) re-arms the window so an over-limit key
 * self-heals after windowMs instead of blocking forever.
 *
 * Rate limiting exists to blunt abuse, not to be a new single point of
 * failure: any store error (Redis down, timeout, ...) fails OPEN — the
 * request is admitted and the error is logged.
 */
/** Reading and changing draw on separate budgets, so a page that polls cannot use up the budget for saving. */
export function splitReadsAndChanges(reads: MiddlewareHandler, changes: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (c.req.method === "GET" || c.req.method === "HEAD" ? reads : changes)(c, next);
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { store, prefix, limit, windowMs, keyFn, message = "too many requests" } = opts;
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
          if (ttlMs === -1) {
            // Key exists WITHOUT an expiry — the first hit's PEXPIRE must have
            // failed. Left alone the counter never resets and this key would
            // 429 forever (the opposite of fail-open), so re-arm the window
            // here: worst case the block self-heals after one more windowMs.
            // -2 (key missing, e.g. expired between INCR and PTTL) needs no
            // repair and falls through to the windowMs fallback below.
            await store.pexpire(key, windowMs);
            ttlMs = windowMs;
          }
        } catch {
          ttlMs = windowMs;
        }
        if (!Number.isFinite(ttlMs) || ttlMs < 0) ttlMs = windowMs;
        const retryAfterSec = Math.ceil(ttlMs / 1000);
        c.header("Retry-After", String(retryAfterSec));
        return c.json({ error: message }, 429);
      }
    } catch (err) {
      console.warn(`[rateLimit] store failure for prefix "${prefix}", failing open:`, err);
    }
    await next();
  };
}
