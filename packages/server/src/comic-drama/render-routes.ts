import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { comicDramaIdSchema, comicRenderRequestSchema } from "@lot-agent/core/comic-drama";
import { COMIC_RENDER_TASK } from "../jobs/task-queues.js";
import { ComicEditConflict } from "./edit-repository.js";
import { ComicLibraryError, libraryMissing } from "./library-db.js";
import type { ComicMediaLibrary } from "./media-library.js";
import type { PgComicRenders } from "./render-repository.js";

export function createComicRenderRoutes(repo: PgComicRenders, media: ComicMediaLibrary, queue?: {
  publishNewTask(id: string, type: string): Promise<void>;
  canResumePersisted(id: string): Promise<boolean>;
  resumePersisted(id: string, type: string): Promise<void>;
  stopCancelled(id: string): Promise<void>;
}, accepting?: () => void) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.onError((error, c) => {
    if (error instanceof ComicEditConflict) return c.json({ code: error.code, currentRevision: error.currentRevision }, 409);
    if (error instanceof ComicLibraryError) return c.json({ code: error.code }, error.status);
    console.error("[comic-drama] render request failed", { path: c.req.routePath, errorType: error.name });
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });
  const id = (value: string) => {
    const result = comicDramaIdSchema.safeParse(value);
    return result.success ? result.data : libraryMissing();
  };
  const limit = bodyLimit({ maxSize: 4096, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  app.post("/edits/:id/render", limit, async c => {
    const owner = c.get("userId");
    const fields = comicRenderRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!fields.success) return c.json({ code: "INVALID_INPUT" }, 400);
    if (!queue) throw new ComicLibraryError("RENDER_QUEUE_UNAVAILABLE", 503);
    media.assertAvailable();
    const render = await repo.start(owner, id(c.req.param("id")), fields.data, accepting);
    if (render.created) await queue.publishNewTask(render.id, COMIC_RENDER_TASK)
      .catch(() => console.warn("[comic-drama] render pending delivery", { renderId: render.id }));
    return c.json(await repo.status(owner, render.id), 202);
  });
  app.get("/renders/:id", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await repo.status(c.get("userId"), id(c.req.param("id"))));
  });
  app.delete("/renders/:id", async c => {
    const renderId = id(c.req.param("id"));
    const removed = await repo.remove(c.get("userId"), renderId);
    if (removed?.cancelled) await queue?.stopCancelled(renderId).catch(() => {});
    if (removed?.key) await repo.purgeDeletedFile({ id: removed.id, key: removed.key }, key => media.removeRenderFile(key));
    return c.json({ ok: true });
  });
  app.get("/renders", async c => {
    c.header("Cache-Control", "private, no-store");
    const editId = c.req.query("editId");
    const cursor = c.req.query("cursor");
    if (cursor && cursor.length > 100) throw new ComicLibraryError("INVALID_CURSOR", 400);
    return c.json(await repo.list(c.get("userId"), editId ? id(editId) : null, cursor));
  });
  app.get("/renders/:id/download", async c => {
    c.header("Cache-Control", "private, no-store");
    const owner = c.get("userId");
    const render = await repo.status(owner, id(c.req.param("id")));
    if (!render.mediaId) throw new ComicLibraryError("RENDER_DOWNLOAD_UNAVAILABLE", 409);
    return c.json(await media.renderDownload(owner, render.mediaId, render.id, c.req.query("inline") === "1"));
  });
  app.post("/renders/:id/cancel", async c => {
    const owner = c.get("userId"), renderId = id(c.req.param("id"));
    await repo.status(owner, renderId);
    await repo.control(renderId, async db => {
      await repo.cancel(db, owner, renderId);
      await queue?.stopCancelled(renderId);
    });
    return c.json(await repo.status(owner, renderId));
  });
  app.post("/renders/:id/recover", async c => {
    const owner = c.get("userId"), renderId = id(c.req.param("id"));
    await repo.status(owner, renderId);
    if (!queue) throw new ComicLibraryError("RENDER_RECOVERY_UNAVAILABLE", 409);
    await repo.control(renderId, async db => {
      if (!await queue.canResumePersisted(renderId)) throw new ComicLibraryError("RENDER_RECOVERY_UNAVAILABLE", 409);
      media.assertAvailable();
      await repo.prepareRecovery(db, owner, renderId);
    });
    await queue.resumePersisted(renderId, COMIC_RENDER_TASK)
      .catch(() => console.warn("[comic-drama] recovered render pending delivery", { renderId }));
    return c.json(await repo.status(owner, renderId), 202);
  });
  return app;
}
