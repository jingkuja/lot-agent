import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createAgentRoutes(service: AgentService): Hono {
  const app = new Hono();

  // List all registered agent definitions
  app.get("/", (c) => {
    return c.json(service.agentRegistry.list());
  });

  return app;
}
