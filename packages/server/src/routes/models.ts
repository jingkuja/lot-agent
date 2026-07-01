import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";
import { enrichCatalog } from "../models/catalog.js";

type Variables = { userId: string };
const CACHE_TTL_SEC = 300;

/** GET / — the caller's available models (llm/image/video), enriched with
 * provider + pricing. Cached in Redis per user for CACHE_TTL_SEC. */
export function createModelRoutes(service: AgentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const cacheKey = `models:${userId}`;
    const cached = await service.redis.get(cacheKey);
    if (cached) return c.json(JSON.parse(cached));

    const apiKey = await service.db.getUserApiKey(userId);
    if (!apiKey) return c.json({ error: "no api key" }, 401);

    let raw;
    try {
      raw = await service.tokenhub.listModels(apiKey);
    } catch {
      return c.json({ error: "模型加载失败" }, 502);
    }
    const enriched = enrichCatalog(service.modelCatalog, raw);
    await service.redis.set(cacheKey, JSON.stringify(enriched), "EX", CACHE_TTL_SEC);
    return c.json(enriched);
  });

  return app;
}
