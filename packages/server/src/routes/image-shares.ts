import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

const TOKEN = /^[a-f0-9]{48}$/;

function imageStorageKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value, "https://local.invalid");
    if (!["http:", "https:"].includes(url.protocol)) return null;
    // Use the storage key solely as a lookup selector, never the supplied origin.
    // The database authorizes ownership and returns the canonical stored URL.
    return /^\/static\/assets\/([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function createImageShareRoutes(service: Pick<AgentService, "db">) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

  app.get("/", async (c) => {
    const key = imageStorageKey(c.req.query("url"));
    if (!key) return c.json({ error: "仅支持分享生成的图片" }, 400);
    const share = await service.db.getOwnedImageShare(key, c.get("userId"));
    return share ? c.json(share) : c.json({ error: "作品不存在或无权访问" }, 404);
  });

  app.post("/", async (c) => {
    let body: { url?: unknown; title?: unknown };
    try {
      body = await c.req.json();
      if (!body || typeof body !== "object") throw new Error("invalid body");
    } catch {
      return c.json({ error: "请求格式不正确" }, 400);
    }
    const key = imageStorageKey(body.url);
    if (!key) return c.json({ error: "仅支持分享生成的图片" }, 400);
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
    const share = await service.db.createImageShare(key, c.get("userId"), randomBytes(24).toString("hex"), title || "我用灵渠claw创作的图片");
    return share ? c.json(share) : c.json({ error: "作品不存在或无权访问" }, 404);
  });

  app.delete("/:token", async (c) => {
    const token = c.req.param("token");
    if (!TOKEN.test(token) || !await service.db.revokeImageShare(token, c.get("userId"))) {
      return c.json({ error: "分享不存在或无权操作" }, 404);
    }
    return c.json({ ok: true });
  });
  return app;
}

/** Anonymous access is limited to a deliberately shared image, never its conversation. */
export function createPublicImageShareRoutes(service: Pick<AgentService, "db">) {
  const app = new Hono();
  app.get("/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = c.req.param("token");
    const share = TOKEN.test(token) ? await service.db.getSharedImage(token) : null;
    if (!share) return c.json({ error: "作品不存在或分享已撤销" }, 404);
    return c.json({ title: share.title, url: share.url, mime: share.mime });
  });
  return app;
}
