import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createAuthRoutes(service: AgentService): Hono {
  const app = new Hono();

  // POST /login — public, no auth required
  app.post("/login", async (c) => {
    let body: { email?: string; name?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { email, name } = body;
    if (!email) {
      return c.json({ error: "email is required" }, 400);
    }
    const user = await service.db.upsertUserByEmail(email, name);
    const token = await service.sessions.createSession(user.id);
    return c.json({ token, user });
  });

  // POST /logout — best-effort, no auth check needed
  app.post("/logout", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      if (token) {
        await service.sessions.revoke(token).catch(() => {});
      }
    }
    return c.json({ ok: true });
  });

  // GET /me — requires valid Bearer token
  app.get("/me", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const s = await service.sessions.resolve(token);
    if (!s) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const user = await service.db.getUserById(s.userId);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json(user);
  });

  return app;
}
