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
        }),
      },
    } as unknown as AgentService;
    const app = new Hono();
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
    });
  });
});
