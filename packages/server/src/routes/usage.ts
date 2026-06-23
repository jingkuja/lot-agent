import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createUsageRoutes(service: AgentService) {
  const app = new Hono();

  // GET /summary?by=model_type|model|day
  app.get("/summary", async (c) => {
    const by = c.req.query("by") ?? "model_type";
    if (by !== "model_type" && by !== "model" && by !== "day") {
      return c.json({ error: `Invalid 'by' parameter. Must be one of: model_type, model, day` }, 400);
    }
    const summary = await service.db.getUsageSummary("default", by);
    return c.json(summary);
  });

  // GET /logs?limit=
  app.get("/logs", async (c) => {
    const rawLimit = c.req.query("limit");
    let limit = rawLimit ? parseInt(rawLimit, 10) : 100;
    if (isNaN(limit) || limit < 1) limit = 100;
    if (limit > 500) limit = 500;
    const logs = await service.db.getUsageLogs("default", limit);
    return c.json(logs);
  });

  // GET /balance
  app.get("/balance", async (c) => {
    const [bal, dailySpend, monthlySpend] = await Promise.all([
      service.db.ensureUserBalance("default"),
      service.db.getDailySpend("default"),
      service.db.getMonthlySpend("default"),
    ]);
    return c.json({
      balance: bal.balance,
      daily_limit: bal.daily_limit,
      monthly_limit: bal.monthly_limit,
      dailySpend,
      monthlySpend,
    });
  });

  return app;
}
