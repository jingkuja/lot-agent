import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createRatingRoutes(service: AgentService): Hono {
  const app = new Hono();

  // Set or update rating
  app.post("/:messageId", async (c) => {
    const messageId = c.req.param("messageId");
    const body = await c.req.json<{ rating: number; feedback?: string }>();

    if (body.rating !== 1 && body.rating !== -1) {
      return c.json({ error: "rating must be 1 or -1" }, 400);
    }

    const rating = await service.db.setRating(
      messageId,
      body.rating,
      body.feedback
    );
    return c.json(rating);
  });

  // Get rating for a message
  app.get("/:messageId", async (c) => {
    const messageId = c.req.param("messageId");
    const rating = await service.db.getRating(messageId);
    return c.json(rating ?? null);
  });

  // Remove rating
  app.delete("/:messageId", async (c) => {
    const messageId = c.req.param("messageId");
    const removed = await service.db.removeRating(messageId);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
