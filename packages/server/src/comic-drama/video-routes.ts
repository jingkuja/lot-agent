import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  comicDramaIdSchema, comicFrameSaveSchema, comicTakeReleaseSchema, comicVideoAdoptSchema, comicVideoSearchSchema,
} from "@lot-agent/core/comic-drama";
import { COMIC_VIDEO_TASK } from "../jobs/task-queues.js";
import type { GenerationQueue } from "./generation-routes.js";
import { ComicLibraryError, libraryMissing } from "./library-db.js";
import type { PgComicLibrary } from "./library-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";
import type { PgComicVideo } from "./video-repository.js";

export function createComicVideoRoutes({ repo, media, queue, library }: {
  repo: PgComicVideo; media: ComicMediaLibrary; queue: GenerationQueue; library: PgComicLibrary;
}) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const limit = bodyLimit({ maxSize: 12 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  const id = (value: string) => {
    const parsed = comicDramaIdSchema.safeParse(value);
    return parsed.success ? parsed.data : libraryMissing();
  };
  app.get("/videos", async c => {
    c.header("Cache-Control", "private, no-store");
    const filter = comicVideoSearchSchema.safeParse(c.req.query());
    if (!filter.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.history(c.get("userId"), filter.data));
  });
  app.get("/series/:id/clips/:clipId/videos", async c =>
    c.json(await repo.clip(c.get("userId"), id(c.req.param("id")), id(c.req.param("clipId")))));
  app.get("/video-takes/:id", async c => {
    c.header("Cache-Control", "private, no-store");
    const { taskId: _taskId, ...take } = await repo.take(c.get("userId"), id(c.req.param("id")));
    if (take.state !== "ready" || !take.mediaId) libraryMissing();
    return c.json(take);
  });
  app.post("/series/:id/clips/:clipId/video/adopt", limit, async c => {
    const body = comicVideoAdoptSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.adopt(c.get("userId"), id(c.req.param("id")), id(c.req.param("clipId")), body.data.takeId, body.data.expectedClipRevision);
    return c.json({ ok: true });
  });
  app.get("/video-takes/:id/receipt", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await repo.receipt(c.get("userId"), id(c.req.param("id"))));
  });
  app.post("/video-takes/:id/cancel", limit, async c => {
    const owner = c.get("userId");
    const take = await repo.take(owner, id(c.req.param("id")));
    await repo.cancel(owner, take.id, take.taskId);
    return c.json(await repo.take(owner, take.id));
  });
  app.post("/video-takes/:id/release", limit, async c => {
    const body = comicTakeReleaseSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    const take = await repo.take(owner, id(c.req.param("id")));
    await repo.release(owner, take.id, take.taskId);
    return c.json(await repo.take(owner, take.id));
  });
  app.post("/video-takes/:id/recover", limit, async c => {
    const owner = c.get("userId");
    const take = await repo.take(owner, id(c.req.param("id")));
    media.assertAvailable();
    if (!take.canRecover || !await queue.canResumePersisted(take.taskId) || !await repo.prepareResume(owner, take.id, take.taskId)) {
      throw new ComicLibraryError("RECOVERY_UNAVAILABLE", 409);
    }
    await queue.resumePersisted(take.taskId, COMIC_VIDEO_TASK).catch(() => {
      console.warn("[comic-drama] video recovery pending delivery", { taskId: take.taskId });
    });
    return c.json(await repo.take(owner, take.id), 202);
  });
  app.post("/video-takes/:id/frame", limit, async c => {
    const body = comicFrameSaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    const take = await repo.take(owner, id(c.req.param("id")));
    if (take.state !== "ready" || !take.mediaId) throw new ComicLibraryError("VIDEO_STALE_OR_UNAVAILABLE", 409);
    const { timeMs, destination } = body.data;
    const signal = c.req.raw.signal;
    if (destination.kind === "character") {
      const { characterId, target } = destination;
      await library.validateCharacterAsset(owner, characterId, target);
      const request = await media.extractFrame(owner, take.mediaId, timeMs, signal);
      const saved = await media.upload(request, owner, "character", async file =>
        ({ mediaId: file.id, version: await library.addCharacterAsset(owner, characterId, target, file) }));
      return c.json(saved, 201);
    }
    const { material } = destination;
    if (!["scene", "prop", "other"].includes(material.kind)) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
    const request = await media.extractFrame(owner, take.mediaId, timeMs, signal);
    const saved = await media.upload(request, owner, material.kind, file => library.addMaterial(owner, material, file));
    return c.json({ id: saved }, 201);
  });
  return app;
}
