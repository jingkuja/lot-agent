import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createAgentRoutes(service: AgentService): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  // 全部 Agent 定义 + 当前用户的安装状态与排序
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const installed = await service.db.getUserAgents(userId); // 首次访问触发懒播种
    return c.json(
      service.agentRegistry
        .list()
        .filter((d) => !d.hidden)
        .map((d) => {
        const isInstalled = d.id === "general" ? true : installed.has(d.id);
        return {
          ...d,
          installed: isInstalled,
          sortOrder: installed.has(d.id) ? installed.get(d.id)! : null,
        };
      })
    );
  });

  app.post("/:id/install", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const def = service.agentRegistry.get(id);
    // 隐藏 Agent 对外等同不存在:列表不展示,也不可安装。
    if (!def || def.hidden) return c.json({ error: "Unknown agent" }, 404);
    await service.db.installUserAgent(userId, id);
    return c.json({ ok: true });
  });

  app.delete("/:id/install", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (id === "general") return c.json({ error: "Cannot uninstall the general agent" }, 400);
    await service.db.uninstallUserAgent(userId, id);
    return c.json({ ok: true });
  });

  app.post("/:id/promote", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const def = service.agentRegistry.get(id);
    if (!def || def.hidden) return c.json({ error: "Unknown agent" }, 404);
    if (!(await service.db.isUserAgentInstalled(userId, id)))
      return c.json({ error: "Agent not installed" }, 400);
    await service.db.promoteUserAgent(userId, id);
    return c.json({ ok: true });
  });

  return app;
}
