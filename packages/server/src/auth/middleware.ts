import type { MiddlewareHandler } from "hono";
import type { SessionStore } from "./session-store.js";

export function createAuthMiddleware(sessions: SessionStore): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const s = await sessions.resolve(token);
    if (!s) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("userId", s.userId);
    await next();
  };
}
