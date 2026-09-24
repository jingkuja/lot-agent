import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createVideoDraftRoutes(service: Pick<AgentService, "generateVideoCopy">) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.post("/", async (c) => {
    if (!c.get("userId")) return c.json({ error: "请先登录" }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.topic !== "string" || !body.topic.trim() || body.topic.length > 1000) {
      return c.json({ error: "请填写 1–1000 字的视频主题" }, 400);
    }
    try {
      return c.json(await service.generateVideoCopy(body.topic.trim(), c.get("userId"), c.req.raw.signal));
    } catch {
      return c.json({ error: "文案生成失败，请检查积分后重试，也可直接填写文案" }, 502);
    }
  });
  return app;
}
