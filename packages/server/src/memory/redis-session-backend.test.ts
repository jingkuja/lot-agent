import { describe, it, expect } from "vitest";
import { RedisSessionBackend } from "./redis-session-backend.js";
import type { MemoryEntry } from "@lot-agent/core";

class FakeRedis {
  store = new Map<string, string>();
  lastSet?: { key: string; mode: string; ttl: number };
  async get(key: string) { return this.store.get(key) ?? null; }
  async set(key: string, val: string, mode: string, ttl: number) {
    this.lastSet = { key, mode, ttl };
    this.store.set(key, val);
    return "OK";
  }
  async del(key: string) { this.store.delete(key); return 1; }
}

const entry = (key: string, value: string): MemoryEntry => ({
  key,
  value,
  tier: "session",
  createdAt: Date.now(),
});

describe("RedisSessionBackend", () => {
  it("round-trips entries under a conversation key with 20min TTL", async () => {
    const redis = new FakeRedis();
    const backend = new RedisSessionBackend(redis as never);
    await backend.save("c1", [entry("pending", "confirm")]);
    expect(redis.lastSet).toEqual({ key: "mem:session:c1", mode: "EX", ttl: 1200 });
    const loaded = await backend.load("c1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].value).toBe("confirm");
  });

  it("returns [] for a missing conversation", async () => {
    const backend = new RedisSessionBackend(new FakeRedis() as never);
    expect(await backend.load("nope")).toEqual([]);
  });

  it("deletes the key when saving empty entries", async () => {
    const redis = new FakeRedis();
    const backend = new RedisSessionBackend(redis as never);
    redis.store.set("mem:session:c1", "[]");
    await backend.save("c1", []);
    expect(redis.store.has("mem:session:c1")).toBe(false);
  });
});
