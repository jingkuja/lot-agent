import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createAgentRoutes(service: AgentService): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  // 所有可见 Agent 默认可用；保留历史排序与 installed 字段供旧客户端兼容。
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const installed = await service.db.getUserAgents(userId); // 首次访问触发懒播种
    return c.json(
      service.agentRegistry
        .list()
        .filter((d) => !d.hidden)
        .map((d) => {
          return {
            ...d,
            installed: true,
            sortOrder: installed.has(d.id) ? installed.get(d.id)! : d.id === "digital_employee" ? -1 : null,
          };
        })
    );
  });

  app.post("/:id/install", async (c) => {
    const id = c.req.param("id");
    const def = service.agentRegistry.get(id);
    // 隐藏 Agent 对外等同不存在:列表不展示,也不可安装。
    if (!def || def.hidden) return c.json({ error: "Unknown agent" }, 404);
    // Legacy install is idempotent: all visible Agents are already available.
    return c.json({ ok: true });
  });

  app.delete("/:id/install", async (c) => {
    const def = service.agentRegistry.get(c.req.param("id"));
    if (!def || def.hidden) return c.json({ error: "Unknown agent" }, 404);
    return c.json({ error: "All agents are built in and cannot be uninstalled" }, 400);
  });

  app.post("/:id/promote", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const def = service.agentRegistry.get(id);
    if (!def || def.hidden) return c.json({ error: "Unknown agent" }, 404);
    // Older accounts may have no ordering row for a now built-in Agent.
    await service.db.installUserAgent(userId, id);
    await service.db.promoteUserAgent(userId, id);
    return c.json({ ok: true });
  });

  return app;
}
