import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

export function createAssetRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  // GET / — files explicitly uploaded by the current user.
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const files = await service.db.listUserUploads(userId);
    return c.json({
      data: files.map((file) => ({
        id: file.id,
        filename: file.original_name || file.storage_key,
        mime: file.mime,
        size: Number(file.size_bytes),
        url: file.url,
        createdAt: file.created_at,
      })),
    });
  });

  // GET /:id — asset metadata, ownership check
  app.get("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const a = await service.db.getAsset(id);
    if (!a) return c.json({ error: "Not found" }, 404);
    if (a.user_id !== userId) return c.json({ error: "Not found" }, 404);
    return c.json(a);
  });

  // DELETE /:id — user-owned uploads only; generated artifacts are immutable here.
  app.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const asset = await service.db.getAsset(id);
    if (!asset || asset.user_id !== userId || asset.type !== "upload") {
      return c.json({ error: "Not found" }, 404);
    }

    await service.uploadStorage.delete(asset.storage_key);
    const deleted = await service.db.deleteUserUpload(id, userId);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
