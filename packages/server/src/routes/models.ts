import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { estimateVideoTokenPoints } from "../billing/video-points-estimate.js";
import type { AgentService } from "../services/agent-service.js";
import { TokenhubClientError, type ModelEstimateRequest } from "../tokenhub/client.js";

type Variables = { userId: string };

/** GET / — the caller's available models (llm/image/video), enriched with
 * provider + pricing. Fetch + per-user Redis cache live in
 * AgentService.getUserModelCatalog (shared with title-model resolution). */
export function createModelRoutes(service: AgentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const apiKey = await service.db.getUserApiKey(userId, service.managedKeysEnabled);
    if (service.managedKeysEnabled && !apiKey) {
      return c.json({ error: "托管模型凭证不可用" }, 503);
    }
    let catalog;
    try {
      catalog = await service.getUserModelCatalog(userId, apiKey);
    } catch {
      return c.json({ error: "模型加载失败" }, 502);
    }
    if (!catalog) return c.json({ llm: [], image: [], video: [] });
    return c.json(catalog);
  });

  app.post("/estimate", bodyLimit({ maxSize: 16_384 }), async (c) => {
    let body: Partial<ModelEstimateRequest> | null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid model estimate request", code: "invalid_estimate_usage" }, 400);
    }
    if (typeof body?.model !== "string" || !body.model.trim() || body.model.length > 255) {
      return c.json({ error: "A model is required", code: "invalid_estimate_usage" }, 400);
    }
    const apiKey = await service.db.getUserApiKey(c.get("userId"), service.managedKeysEnabled);
    if (!apiKey) return c.json({ error: "Model credential unavailable", code: "model_credential_unavailable" }, 503);

    try {
      const { model, input_tokens, output_tokens, cached_input_tokens, image, video, request_parameters } = body;
      if (video != null) {
        const catalog = await service.tokenhub.listModels(apiKey, c.req.raw.signal);
        if (catalog.video_token_models?.includes(model)) {
          const estimatedPoints = estimateVideoTokenPoints(model, video.resolution, video.seconds);
          if (image != null) return c.json({ error: "Use one media estimate per request", code: "invalid_estimate_usage" }, 400);
          if (estimatedPoints == null) {
            return c.json({ error: "Video estimate requires a resolution and positive duration in seconds", code: "invalid_estimate_usage" }, 400);
          }
          return c.json({ model, pricingScheme: "video_token", estimatedPoints, estimatedQuota: null });
        }
      }
      const estimate = { model, input_tokens, output_tokens, cached_input_tokens, image, video, request_parameters };
      return c.json(await service.tokenhub.estimateModelCost(apiKey, estimate, c.req.raw.signal));
    } catch (err) {
      const status = err instanceof TokenhubClientError ? err.status : undefined;
      switch (status) {
        case 400:
          return c.json({ error: "Invalid model estimate request", code: "invalid_estimate_usage" }, 400);
        case 401:
        case 403:
          return c.json({ error: "Model access denied", code: "model_access_denied" }, 403);
        case 413:
          return c.json({ error: "Model estimate request is too large", code: "invalid_estimate_usage" }, 413);
        case 422:
          return c.json({ error: "Model estimate unavailable", code: "model_estimate_unavailable" }, 422);
        case 429:
          return c.json({ error: "Model estimate rate limit exceeded", code: "model_estimate_rate_limited" }, 429);
        case 503:
          return c.json({ error: "Model estimate unavailable", code: "model_estimate_unavailable" }, 503);
        default:
          return c.json({ error: "Model estimate failed", code: "model_estimate_failed" }, 502);
      }
    }
  });

  return app;
}
