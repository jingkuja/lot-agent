import { Hono } from "hono";
import { internationalModelsEnabled } from "../tokenhub/model-access.js";

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
  // dotenv values are strings. Only a finite positive number opts in.
  const value = Number(process.env.globle);
  const globle = internationalModelsEnabled() ? 1 : 0;
  const app = new Hono();
  app.get("/", (c) => c.json({
    globle,
    showCompliance: !process.env.globle?.trim() || value === 0,
    webUrl: publicUrl(process.env.LOT_AGENT_PUBLIC_URL, "https://todoucloud.com/"),
    tokenhubUrl: publicUrl(process.env.TOKENHUB_PUBLIC_URL, "https://tokenhub.todoucloud.com/"),
  }));
  return app;
}
