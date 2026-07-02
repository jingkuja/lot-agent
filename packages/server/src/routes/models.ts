import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

/** GET / — the caller's available models (llm/image/video), enriched with
 * provider + pricing. Fetch + per-user Redis cache live in
 * AgentService.getUserModelCatalog (shared with title-model resolution). */
export function createModelRoutes(service: AgentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const apiKey = await service.db.getUserApiKey(userId);
    let catalog;
    try {
      catalog = await service.getUserModelCatalog(userId, apiKey);
    } catch {
      return c.json({ error: "模型加载失败" }, 502);
    }
    if (!catalog) return c.json({ error: "no api key" }, 401);
    return c.json(catalog);
  });

  return app;
}
