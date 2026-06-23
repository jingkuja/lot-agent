import { createHash } from "node:crypto";
import type Redis from "ioredis";

/** Stable cache key for a generation request (order-independent over input keys). */
export function genCacheKey(type: string, input: unknown): string {
  const hash = createHash("sha256").update(stableStringify(input)).digest("hex");
  return `gen:${type}:${hash}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
    .join(",")}}`;
}

export class GenCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec = 86400
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const v = await this.redis.get(key);
    return v ? (JSON.parse(v) as T) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), "EX", this.ttlSec);
  }
}
