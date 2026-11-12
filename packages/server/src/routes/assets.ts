import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";
import { documentAssetKey, parseFileUrl, resolveImageReferenceUrl, signPrivateFile, signPrivateMaterial } from "../generation/private-materials.js";

type Variables = { userId: string };

const MAX_LINKS = 100;

export function createAssetRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

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
        url: signPrivateMaterial(file),
        createdAt: file.created_at,
      })),
    });
  });

  // POST /links — the owner's working links for stored file URLs. Stored URLs never change, so
  // messages stay valid; a file that is public, or not this user's, comes back unchanged.
  app.post("/links", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null) as { urls?: unknown } | null;
    const urls = body?.urls;
    if (!Array.isArray(urls) || urls.length > MAX_LINKS || urls.some((url) => typeof url !== "string")) {
      return c.json({ error: "Invalid urls" }, 400);
    }
    const links: Record<string, string> = {};
    for (const url of new Set(urls as string[])) {
      if (/\/static\/assets\//.test(url)) {
        links[url] = await resolveImageReferenceUrl(service.db, userId, url, { allowRelative: true }).catch(() => url);
        continue;
      }
      const file = parseFileUrl(url);
      const asset = !file ? null : file.folder === "uploads"
        ? await service.db.getUploadByStorageKey(file.key)
        : await service.db.getGeneratedByStorageKey(documentAssetKey(file.key));
      links[url] = asset?.is_private && asset.user_id === userId ? signPrivateFile(userId, url) : url;
    }
    return c.json({ links });
  });

  // GET /:id — asset metadata, ownership check
  app.get("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const a = await service.db.getAsset(id);
    if (!a) return c.json({ error: "Not found" }, 404);
    if (a.user_id !== userId) return c.json({ error: "Not found" }, 404);
    return c.json({ ...a, url: signPrivateMaterial(a) });
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
