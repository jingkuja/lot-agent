import type Redis from "ioredis";
import type { SessionMemoryBackend, MemoryEntry } from "@lot-agent/core";

const SESSION_TTL_SEC = 20 * 60; // 20 minutes
const keyFor = (conversationId: string) => `mem:session:${conversationId}`;

/**
 * Redis-backed session memory tier, keyed per conversation.
 * The whole tier is serialized to one JSON value; TTL refreshes on each save.
 */
export class RedisSessionBackend implements SessionMemoryBackend {
  constructor(private readonly redis: Redis) {}

  async load(conversationId: string): Promise<MemoryEntry[]> {
    const raw = await this.redis.get(keyFor(conversationId));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as MemoryEntry[];
    } catch {
      return [];
    }
  }

  async save(conversationId: string, entries: MemoryEntry[]): Promise<void> {
    const key = keyFor(conversationId);
    if (entries.length === 0) {
      await this.redis.del(key);
      return;
    }
    await this.redis.set(key, JSON.stringify(entries), "EX", SESSION_TTL_SEC);
  }
}
