import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createTraceRoutes(service: AgentService): Hono {
  const app = new Hono();

  // List traces
  app.get("/", async (c) => {
    const conversationId = c.req.query("conversationId");
    const traces = await service.db.getTraces(conversationId ?? undefined);
    return c.json(traces);
  });

  // Get trace detail with spans
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const trace = await service.db.getTrace(id);
    if (!trace) return c.json({ error: "Not found" }, 404);
    const spans = await service.db.getSpans(id);
    return c.json({ ...trace, spans });
  });

  return app;
}
