import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AgentService } from "../services/agent-service.js";
import { createUsageRoutes, summarizeBalance } from "./usage.js";

describe("summarizeBalance", () => {
  it("reports historical recharge and used ratio in monetary units", () => {
    expect(summarizeBalance(3, 1)).toEqual({
      balance: 3,
      totalUsed: 1,
      totalRecharged: 4,
      usedRatio: 0.25,
    });
  });

  it("keeps an empty account ratio finite", () => {
    expect(summarizeBalance(0, 0).usedRatio).toBe(0);
  });

  it("uses the recharge ledger total when supplied", () => {
    expect(summarizeBalance(3, 1, 10)).toMatchObject({
      totalRecharged: 10,
      usedRatio: 0.1,
    });
  });
});

describe("GET /balance", () => {
  it("shares one preference between web and mini-program without leaking another account's state", async () => {
    const preferences = new Map([[7, false], [8, false]]);
    const service = {
      managedKeysEnabled: true,
      db: {
        getUserById: vi.fn(async (id: string) => ({ external_user_id: id === "u1" ? 7 : 8 })),
        getDailySpend: vi.fn().mockResolvedValue(0), getMonthlySpend: vi.fn().mockResolvedValue(0),
      },
      tokenhub: {
        getManagedBalance: vi.fn(async (id: number) => ({ remainAmount: id, usedAmount: 0, allowBalanceFallback: preferences.get(id) })),
        setManagedBalanceFallback: vi.fn(async (id: number, enabled: boolean) => { preferences.set(id, enabled); return enabled; }),
      },
    } as unknown as AgentService;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", c.req.header("x-user") ?? "u1"); await next(); });
    app.route("/", createUsageRoutes(service));
    const update = await app.request("/balance-fallback", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, userId: "u2" }),
    });
    expect(update.status).toBe(200);
    for (const client of ["web", "miniprogram"]) {
      const result = await app.request("/balance", { headers: { "X-Lot-Client": client } });
      expect(await result.json()).toMatchObject({ balance: 7, allowBalanceFallback: true });
    }
    const other = await app.request("/balance", { headers: { "x-user": "u2", "X-Lot-Client": "miniprogram" } });
    expect(await other.json()).toMatchObject({ balance: 8, allowBalanceFallback: false });
  });

  it("reports an upstream save failure instead of acknowledging a successful toggle", async () => {
    const service = {
      managedKeysEnabled: true,
      db: { getUserById: vi.fn().mockResolvedValue({ external_user_id: 7 }) },
      tokenhub: { setManagedBalanceFallback: vi.fn().mockRejectedValue(new Error("private upstream detail")) },
    } as unknown as AgentService;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    app.route("/", createUsageRoutes(service));
    const result = await app.request("/balance-fallback", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "余额补扣设置保存失败" });
  });

  it("returns monetary history from the managed recharge ledger", async () => {
    const service = {
      managedKeysEnabled: true,
      db: {
        getUserById: vi.fn().mockResolvedValue({ external_user_id: 7 }),
        getDailySpend: vi.fn().mockResolvedValue(0.1),
        getMonthlySpend: vi.fn().mockResolvedValue(0.5),
      },
      tokenhub: {
        getManagedBalance: vi.fn().mockResolvedValue({
          remainAmount: 3,
          usedAmount: 1,
          rechargedAmount: 10,
          status: "active",
          credentialVersion: 1,
          policyRevision: 1,
          allowBalanceFallback: false,
        }),
      },
    } as unknown as AgentService;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", "local-1");
      await next();
    });
    app.route("/", createUsageRoutes(service));

    const response = await app.request("/balance");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      balance: 3,
      totalUsed: 1,
      totalRecharged: 10,
      usedRatio: 0.1,
      allowBalanceFallback: false,
    });
  });

  it("updates the managed key balance-fallback preference for the same user", async () => {
    const service = {
      managedKeysEnabled: true,
      db: {
        getUserById: vi.fn().mockResolvedValue({ external_user_id: 7 }),
      },
      tokenhub: {
        setManagedBalanceFallback: vi.fn().mockResolvedValue(true),
      },
    } as unknown as AgentService;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", "local-1");
      await next();
    });
    app.route("/", createUsageRoutes(service));

    const response = await app.request("/balance-fallback", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(service.tokenhub.setManagedBalanceFallback).toHaveBeenCalledWith(7, true);
  });
});
