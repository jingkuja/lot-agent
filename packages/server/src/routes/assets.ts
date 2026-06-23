import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

export function createAssetRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  // GET /:id — asset metadata, ownership check
  app.get("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const a = await service.db.getAsset(id);
    if (!a) return c.json({ error: "Not found" }, 404);
    if (a.user_id !== userId) return c.json({ error: "Not found" }, 404);
    return c.json(a);
  });

  return app;
}
