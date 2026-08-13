import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createKnowledgeBaseRoutes(service: AgentService): Hono {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get("/", async (c) => {
    try {
      return c.json({ data: await service.listKnowledgeBases(c.get("userId")) });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "知识库服务不可用" },
        502
      );
    }
  });

  app.post("/link", async (c) => {
    try {
      return c.json({ url: await service.createKnowledgeBaseLink(c.get("userId")) });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "知识库跳转失败" },
        502
      );
    }
  });

  return app;
}
