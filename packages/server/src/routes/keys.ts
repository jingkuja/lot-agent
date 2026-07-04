import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

/** POST /active { index } — 切换当前用户的激活 api-key（按 index），
 * 并清掉 Redis 模型目录缓存，使下次 GET /api/models 用新 key 重新拉取。 */
export function createKeyRoutes(service: AgentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/active", async (c) => {
    const userId = c.get("userId");
    let body: { index?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "无效的 key" }, 400);
    }
    const index = body.index;
    if (typeof index !== "number" || !Number.isInteger(index)) {
      return c.json({ error: "无效的 key" }, 400);
    }
    try {
      await service.db.setActiveApiKey(userId, index);
    } catch (err) {
      if (err instanceof Error && err.message === "index_out_of_range") {
        return c.json({ error: "无效的 key" }, 400);
      }
      return c.json({ error: "切换失败" }, 500);
    }
    await service.redis.del(`models:${userId}`);
    return c.json({ ok: true, activeKeyIndex: index });
  });

  return app;
}
