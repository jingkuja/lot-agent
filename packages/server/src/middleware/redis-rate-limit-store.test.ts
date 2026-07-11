import { describe, it, expect } from "vitest";
import { RedisRateLimitStore } from "./redis-rate-limit-store.js";

class FakeRedis {
  calls: { method: string; args: unknown[] }[] = [];
  async incr(key: string) {
    this.calls.push({ method: "incr", args: [key] });
    return 3;
  }
  async pexpire(key: string, ms: number) {
    this.calls.push({ method: "pexpire", args: [key, ms] });
    return 1;
  }
  async pttl(key: string) {
    this.calls.push({ method: "pttl", args: [key] });
    return 4200;
  }
}

describe("RedisRateLimitStore", () => {
  it("delegates incr/pexpire/pttl directly to the underlying ioredis client", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis as never);

    expect(await store.incr("rl:test:1.2.3.4")).toBe(3);
    expect(await store.pexpire("rl:test:1.2.3.4", 60_000)).toBe(1);
    expect(await store.pttl("rl:test:1.2.3.4")).toBe(4200);

    expect(redis.calls).toEqual([
      { method: "incr", args: ["rl:test:1.2.3.4"] },
      { method: "pexpire", args: ["rl:test:1.2.3.4", 60_000] },
      { method: "pttl", args: ["rl:test:1.2.3.4"] },
    ]);
  });
});
