import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createAssetRoutes(service: AgentService) {
  const app = new Hono();

  // GET /:id — asset metadata
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const a = await service.db.getAsset(id);
    if (!a) return c.json({ error: "Not found" }, 404);
    return c.json(a);
  });

  return app;
}
