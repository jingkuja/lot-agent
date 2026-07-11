import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

export function createTraceRoutes(service: AgentService): Hono {
  const app = new Hono<{ Variables: Variables }>();

  /** Cross-user access collapses to 404 so resource existence never leaks. */
  const ownsConversation = async (conversationId: string, userId: string) => {
    const conversation = await service.db.getConversation(conversationId);
    return !!conversation && (conversation as { user_id?: string }).user_id === userId;
  };

  // List traces — scoped to one of the caller's own conversations. There is
  // deliberately no site-wide listing: traces expose model/tool/latency data.
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.query("conversationId");
    if (!conversationId) {
      return c.json({ error: "conversationId is required" }, 400);
    }
    if (!(await ownsConversation(conversationId, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const traces = await service.db.getTraces(conversationId);
    return c.json(traces);
  });

  // Get trace detail with spans — ownership via the trace's conversation
  app.get("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const trace = await service.db.getTrace(id);
    if (!trace) return c.json({ error: "Not found" }, 404);
    if (!(await ownsConversation(trace.conversation_id, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const spans = await service.db.getSpans(id);
    return c.json({ ...trace, spans });
  });

  return app;
}
