import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { rateLimit, clientIp, type RateLimitStore } from "./rate-limit.js";

/**
 * In-memory fake mimicking the Redis fixed-window semantics the real store
 * uses (INCR / PEXPIRE / PTTL), driven off `Date.now()` so tests can control
 * time via vitest fake timers instead of real sleeps.
 */
class FakeStore implements RateLimitStore {
  counts = new Map<string, number>();
  expiresAt = new Map<string, number>();
  pexpireCalls: { key: string; ms: number }[] = [];

  async incr(key: string): Promise<number> {
    this.expireIfDue(key);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async pexpire(key: string, ms: number): Promise<unknown> {
    this.pexpireCalls.push({ key, ms });
    this.expiresAt.set(key, Date.now() + ms);
    return 1;
  }

  async pttl(key: string): Promise<number> {
    const exp = this.expiresAt.get(key);
    if (exp == null) return -1;
    return exp - Date.now();
  }

  private expireIfDue(key: string) {
    const exp = this.expiresAt.get(key);
    if (exp != null && exp <= Date.now()) {
      this.counts.delete(key);
      this.expiresAt.delete(key);
    }
  }
}

class ThrowingStore implements RateLimitStore {
  async incr(): Promise<number> {
    throw new Error("redis is down");
  }
  async pexpire(): Promise<unknown> {
    throw new Error("redis is down");
  }
  async pttl(): Promise<number> {
    throw new Error("redis is down");
  }
}

function buildApp(store: RateLimitStore, opts?: Partial<Parameters<typeof rateLimit>[0]>) {
  const app = new Hono();
  const mw = rateLimit({
    store,
    prefix: "rl:test",
    limit: 2,
    windowMs: 60_000,
    keyFn: () => "fixed-key",
    ...opts,
  });
  app.post("/test", mw, (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit", async () => {
    const store = new FakeStore();
    const app = buildApp(store);
    const res1 = await app.request("/test", { method: "POST" });
    const res2 = await app.request("/test", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it("returns 429 with a Retry-After header once the limit is exceeded", async () => {
    const store = new FakeStore();
    const app = buildApp(store);
    await app.request("/test", { method: "POST" });
    await app.request("/test", { method: "POST" });
    const res3 = await app.request("/test", { method: "POST" });
    expect(res3.status).toBe(429);
    const body = await res3.json();
    expect(body).toEqual({ error: "too many requests" });
    const retryAfter = res3.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("only sets the window expiry on the first hit", async () => {
    const store = new FakeStore();
    const app = buildApp(store);
    await app.request("/test", { method: "POST" });
    await app.request("/test", { method: "POST" });
    await app.request("/test", { method: "POST" }); // 3rd, already over limit
    expect(store.pexpireCalls.length).toBe(1);
    expect(store.pexpireCalls[0]).toEqual({ key: "rl:test:fixed-key", ms: 60_000 });
  });

  it("tracks different keys independently", async () => {
    const store = new FakeStore();
    const app = new Hono();
    let currentKey = "a";
    const mw = rateLimit({
      store,
      prefix: "rl:test",
      limit: 1,
      windowMs: 60_000,
      keyFn: () => currentKey,
    });
    app.post("/test", mw, (c) => c.json({ ok: true }));

    currentKey = "a";
    const a1 = await app.request("/test", { method: "POST" });
    currentKey = "b";
    const b1 = await app.request("/test", { method: "POST" });
    currentKey = "a";
    const a2 = await app.request("/test", { method: "POST" });

    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200); // independent bucket, not affected by a's count
    expect(a2.status).toBe(429); // a's second request exceeds its own limit of 1
  });

  it("resets the window after it expires", async () => {
    const store = new FakeStore();
    const app = buildApp(store);
    await app.request("/test", { method: "POST" });
    await app.request("/test", { method: "POST" });
    const blocked = await app.request("/test", { method: "POST" });
    expect(blocked.status).toBe(429);

    vi.advanceTimersByTime(60_001);

    const afterExpiry = await app.request("/test", { method: "POST" });
    expect(afterExpiry.status).toBe(200);
  });

  it("fails open (passes through) and warns when the store throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = buildApp(new ThrowingStore());
    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("clientIp", () => {
  function buildIpApp() {
    const app = new Hono();
    app.get("/ip", (c) => c.json({ ip: clientIp(c) }));
    return app;
  }

  it("takes the first entry of x-forwarded-for, trimmed", async () => {
    const app = buildIpApp();
    const res = await app.request("/ip", {
      headers: { "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" },
    });
    expect((await res.json()).ip).toBe("1.2.3.4");
  });

  it("falls back to 'unknown' when no header and no socket info", async () => {
    const app = buildIpApp();
    const res = await app.request("/ip");
    expect((await res.json()).ip).toBe("unknown");
  });
});
