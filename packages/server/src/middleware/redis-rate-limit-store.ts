import type Redis from "ioredis";
import type { RateLimitStore } from "./rate-limit.js";

/**
 * Production {@link RateLimitStore}: thin passthrough onto the server's
 * shared ioredis connection (`AgentService.redis` — the same connection used
 * for the model-catalog cache and session memory; rate limiting only needs
 * plain command execution, not BullMQ's blocking-command variant).
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  pexpire(key: string, ms: number): Promise<unknown> {
    return this.redis.pexpire(key, ms);
  }

  pttl(key: string): Promise<number> {
    return this.redis.pttl(key);
  }
}
