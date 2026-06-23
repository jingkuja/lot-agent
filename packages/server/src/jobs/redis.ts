import Redis from "ioredis";

/**
 * Create an IORedis connection configured for BullMQ.
 * BullMQ requires maxRetriesPerRequest: null.
 */
export function createRedisConnection(url?: string): Redis {
  const redisUrl = url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
}

let _sharedConn: Redis | null = null;

/**
 * Lazily-created shared Redis connection (singleton).
 * Uses REDIS_URL env or defaults to redis://localhost:6379.
 */
export function getRedis(): Redis {
  if (!_sharedConn) {
    _sharedConn = createRedisConnection();
  }
  return _sharedConn;
}
