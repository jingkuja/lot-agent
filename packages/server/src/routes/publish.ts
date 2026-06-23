import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

export function createPlatformRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  // GET /auth/:platform — return OAuth auth URL for a platform
  app.get("/auth/:platform", (c) => {
    const platform = c.req.param("platform");
    const conn = service.connectors.get(platform);
    if (!conn) return c.json({ error: "Unknown platform" }, 404);
    return c.json({ authUrl: conn.getAuthUrl(c.get("userId")) });
  });

  // POST /:platform/connect — exchange OAuth code for access token
  app.post("/:platform/connect", async (c) => {
    const platform = c.req.param("platform");
    const body = await c.req.json<{ code?: string }>();
    if (!body.code) return c.json({ error: "Missing code" }, 400);
    const conn = service.connectors.get(platform);
    if (!conn) return c.json({ error: "Unknown platform" }, 404);
    const { accessToken, expiresAt } = await conn.exchangeToken(body.code);
    await service.db.upsertPlatformAccount({
      userId: c.get("userId"),
      platform,
      accessToken,
      expiresAt: new Date(expiresAt),
    });
    return c.json({ ok: true, platform });
  });

  return app;
}

export function createPublishRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  // POST / — publish content to a platform (with review gate)
  app.post("/", async (c) => {
    const body = await c.req.json<{
      platform?: string;
      title?: string;
      body?: string;
      assetIds?: string[];
    }>();

    const { platform, title, body: bodyText, assetIds } = body;

    if (!platform || !service.connectors.has(platform)) {
      return c.json({ error: "Unknown platform" }, 404);
    }
    if (!title || !bodyText) {
      return c.json({ error: "Missing title or body" }, 400);
    }

    const userId = c.get("userId");

    // Run content review first
    const review = await service.reviewProvider.reviewText(`${title}\n${bodyText}`);
    await service.db.writeReviewLog({
      userId,
      contentType: "text",
      verdict: review.verdict,
      detail: { reasons: review.reasons },
    });

    if (review.verdict === "reject") {
      return c.json({ error: "Content rejected by review", reasons: review.reasons }, 403);
    }

    // Publish
    const conn = service.connectors.get(platform)!;
    const { url } = await conn.publish({ title, body: bodyText, assetIds: assetIds ?? [] });
    const rec = await service.db.createPublishRecord({
      userId,
      platform,
      title,
      status: "published",
      publishedUrl: url,
    });

    return c.json({ url, recordId: rec.id }, 201);
  });

  // GET /records — list user's publish records
  app.get("/records", async (c) => {
    const userId = c.get("userId");
    return c.json(await service.db.getPublishRecords(userId));
  });

  return app;
}
