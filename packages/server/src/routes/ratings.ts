import { Hono } from "hono";
import type { Context } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

export function createRatingRoutes(service: AgentService): Hono {
  const app = new Hono<{ Variables: Variables }>();

  /**
   * A rating is only ever the message owner's to touch: verify the
   * message → conversation → user chain, collapsing unknown messages and
   * other users' messages to the same 404.
   */
  const ownsMessage = async (c: Context, messageId: string): Promise<boolean> => {
    const owner = await service.db.getMessageOwner(messageId);
    return !!owner && owner.userId === c.get("userId");
  };

  // Set or update rating
  app.post("/:messageId", async (c) => {
    const messageId = c.req.param("messageId");
    const body = await c.req.json<{ rating: number; feedback?: string }>();

    if (body.rating !== 1 && body.rating !== -1) {
      return c.json({ error: "rating must be 1 or -1" }, 400);
    }
    if (!(await ownsMessage(c, messageId))) {
      return c.json({ error: "Not found" }, 404);
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
    if (!(await ownsMessage(c, messageId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const rating = await service.db.getRating(messageId);
    return c.json(rating ?? null);
  });

  // Remove rating
  app.delete("/:messageId", async (c) => {
    const messageId = c.req.param("messageId");
    if (!(await ownsMessage(c, messageId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const removed = await service.db.removeRating(messageId);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
