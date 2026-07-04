import type { MiddlewareHandler } from "hono";
import type { SessionStore } from "./session-store.js";

/** Debug bypass: when enabled, any request that doesn't resolve to a real
 * session is admitted as the fixed debug user instead of returning 401. This is
 * a local-dev switch (`DEBUG=1`) and must never be enabled in a deployment. */
export interface AuthMiddlewareOptions {
  debug?: boolean;
  debugUserId?: string;
}

export function createAuthMiddleware(
  sessions: SessionStore,
  opts: AuthMiddlewareOptions = {}
): MiddlewareHandler {
  const debugUserId = opts.debug ? opts.debugUserId : undefined;
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const token =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : "";
    const s = token ? await sessions.resolve(token) : null;
    if (s) {
      c.set("userId", s.userId);
      await next();
      return;
    }
    // No valid session. In debug mode fall back to the debug user so the app is
    // usable without logging in; otherwise reject.
    if (debugUserId) {
      c.set("userId", debugUserId);
      await next();
      return;
    }
    return c.json({ error: "Unauthorized" }, 401);
  };
}
