import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createSkillRoutes(service: AgentService): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const skills = service.skillLoader.getSkills();
    return c.json(
      skills.map((s) => ({
        name: s.name,
        description: s.description,
        triggers: s.triggers,
      }))
    );
  });

  return app;
}
