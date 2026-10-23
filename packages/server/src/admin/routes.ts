import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";

export const ADMIN_API_KEY_MIN_LENGTH = 32;
export const ADMIN_WINDOW_MAX_HOURS = 720;

/** The fixed operations key from `ADMIN_API_KEY`. Unset or shorter than 32 characters
 * leaves the admin API unmounted, so its paths answer 404 like any unknown route. */
export function adminApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.ADMIN_API_KEY?.trim();
  if (!key) return undefined;
  if (key.length < ADMIN_API_KEY_MIN_LENGTH) {
    console.warn(`ADMIN_API_KEY is shorter than ${ADMIN_API_KEY_MIN_LENGTH} characters; admin API disabled`);
    return undefined;
  }
  return key;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** `Authorization: Bearer <key>`, compared in constant time; user sessions never pass. */
export function adminAuth(key: string): MiddlewareHandler {
  const expected = digest(key);
  return async (c, next) => {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!presented || !timingSafeEqual(digest(presented), expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

export interface AdminDeps {
  marketingMetrics(hours: number): Promise<unknown>;
  marketingReconciliation(hours: number): Promise<unknown>;
}

/** Read-only operations endpoints for scripts and dashboards; there is no admin UI. */
export function createAdminRoutes(deps: AdminDeps, key: string) {
  const app = new Hono();
  app.use("*", adminAuth(key));
  const window = (read: (hours: number) => Promise<unknown>, fallback: number) => async (c: Context) => {
    const hours = Number(c.req.query("hours") ?? fallback);
    if (!Number.isInteger(hours) || hours < 1 || hours > ADMIN_WINDOW_MAX_HOURS) {
      return c.json({ error: `hours must be an integer 1–${ADMIN_WINDOW_MAX_HOURS}` }, 400);
    }
    c.header("Cache-Control", "no-store");
    return c.json(await read(hours));
  };
  app.get("/metrics/marketing", window(hours => deps.marketingMetrics(hours), 24));
  app.get("/reconciliation/marketing", window(hours => deps.marketingReconciliation(hours), 168));
  return app;
}
