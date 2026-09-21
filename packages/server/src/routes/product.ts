import { Hono } from "hono";

function publicUrl(value: string | undefined, fallback: string): string {
  try {
    const url = new URL(value?.trim() || fallback);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

/** Public destinations only; never derive these from internal gateway credentials. */
export function createProductRoutes() {
  const app = new Hono();
  app.get("/", (c) => c.json({
    webUrl: publicUrl(process.env.LOT_AGENT_PUBLIC_URL, "https://aigc.todoucloud.com/"),
    tokenhubUrl: publicUrl(process.env.TOKENHUB_PUBLIC_URL, "https://tokenhub.todoucloud.com/"),
  }));
  return app;
}
