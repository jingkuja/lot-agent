import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

export function summarizeBalance(balance: number, totalUsed: number, historicalRecharge?: number) {
  const safeBalance = Number.isFinite(balance) ? Math.max(0, balance) : 0;
  const safeUsed = Number.isFinite(totalUsed) ? Math.max(0, totalUsed) : 0;
  const totalRecharged = historicalRecharge !== undefined && Number.isFinite(historicalRecharge)
    ? Math.max(0, historicalRecharge)
    : safeBalance + safeUsed;
  return {
    balance: safeBalance,
    totalUsed: safeUsed,
    totalRecharged,
    usedRatio: totalRecharged > 0 ? Math.min(1, safeUsed / totalRecharged) : 0,
  };
}

export function createUsageRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  // GET /summary?by=model_type|model|day
  app.get("/summary", async (c) => {
    const userId = c.get("userId");
    const by = c.req.query("by") ?? "model_type";
    if (by !== "model_type" && by !== "model" && by !== "day") {
      return c.json({ error: `Invalid 'by' parameter. Must be one of: model_type, model, day` }, 400);
    }
    const summary = await service.db.getUsageSummary(userId, by);
    return c.json(summary);
  });

  // GET /logs?limit=
  app.get("/logs", async (c) => {
    const userId = c.get("userId");
    const rawLimit = c.req.query("limit");
    let limit = rawLimit ? parseInt(rawLimit, 10) : 100;
    if (isNaN(limit) || limit < 1) limit = 100;
    if (limit > 500) limit = 500;
    const logs = await service.db.getUsageLogs(userId, limit);
    return c.json(logs);
  });

  // GET /balance
  app.get("/balance", async (c) => {
    const userId = c.get("userId");
    const user = await service.db.getUserById(userId);
    if (service.managedKeysEnabled && user?.external_user_id != null) {
      try {
        const [managed, dailySpend, monthlySpend] = await Promise.all([
          service.tokenhub.getManagedBalance(user.external_user_id),
          service.db.getDailySpend(userId),
          service.db.getMonthlySpend(userId),
        ]);
        return c.json({
          ...summarizeBalance(managed.remainAmount, managed.usedAmount, managed.rechargedAmount),
          status: managed.status,
          credentialVersion: managed.credentialVersion,
          policyRevision: managed.policyRevision,
          dailySpend,
          monthlySpend,
        });
      } catch {
        return c.json({ error: "额度加载失败" }, 502);
      }
    }
    const [bal, dailySpend, monthlySpend, totalSpend] = await Promise.all([
      service.db.ensureUserBalance(userId),
      service.db.getDailySpend(userId),
      service.db.getMonthlySpend(userId),
      service.db.getTotalSpend(userId),
    ]);
    return c.json({
      ...summarizeBalance(bal.balance, totalSpend),
      daily_limit: bal.daily_limit,
      monthly_limit: bal.monthly_limit,
      dailySpend,
      monthlySpend,
    });
  });

  return app;
}
