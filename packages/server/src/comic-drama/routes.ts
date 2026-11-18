import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  comicDramaIdSchema, comicDramaRevisionSchema, comicDramaScriptWriteSchema, comicDramaSeriesListSchema,
  comicDramaSetCurrentSchema, createComicDramaSeriesSchema, reorderComicDramaClipsSchema, updateComicDramaClipSchema,
  updateComicDramaSeriesSchema, type ComicDramaRepository,
} from "@lot-agent/core/comic-drama";
import { ComicDramaError } from "./repository.js";

type Variables = { userId: string };

export function createComicDramaRoutes(repo: ComicDramaRepository, canSelectModel: (owner: string, model: string) => Promise<boolean>) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("/series/*", bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof ComicDramaError) {
      if (error.code === "REVISION_CONFLICT") return c.json({ code: error.code, currentRevision: error.currentRevision }, 409);
      return c.json({ code: error.code }, error.code === "NOT_FOUND" ? 404 : 400);
    }
    console.error("[comic-drama] workspace request failed", { path: c.req.routePath, errorType: error.name });
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });
  const seriesId = (value: string) => {
    const parsed = comicDramaIdSchema.safeParse(value);
    if (!parsed.success) throw new ComicDramaError("NOT_FOUND");
    return parsed.data;
  };

  app.get("/series", async c => {
    const input = comicDramaSeriesListSchema.safeParse(c.req.query());
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.list(c.get("userId"), input.data));
  });
  app.post("/series", async c => {
    const input = createComicDramaSeriesSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    if (input.data.videoModel && !await canSelectModel(owner, input.data.videoModel)) return c.json({ code: "MODEL_UNAVAILABLE" }, 400);
    return c.json(await repo.create(owner, input.data), 201);
  });
  app.get("/series/current", async c => c.json({ seriesId: await repo.current(c.get("userId")) }));
  app.put("/series/current", async c => {
    const input = comicDramaSetCurrentSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const opened = await repo.open(c.get("userId"), input.data.seriesId);
    return c.json({ seriesId: opened.series.id, ...opened });
  });
  app.get("/series/:id", async c => c.json(await repo.get(c.get("userId"), seriesId(c.req.param("id")))));
  app.patch("/series/:id", async c => {
    const input = updateComicDramaSeriesSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId"), id = seriesId(c.req.param("id"));
    const { videoModel } = input.data;
    if (videoModel && videoModel !== (await repo.get(owner, id)).series.videoModel && !await canSelectModel(owner, videoModel)) {
      return c.json({ code: "MODEL_UNAVAILABLE" }, 400);
    }
    return c.json(await repo.update(owner, id, input.data));
  });
  for (const [action, sequel] of [["copy", false], ["sequel", true]] as const) {
    app.post(`/series/:id/${action}`, async c => c.json(await repo.derive(c.get("userId"), seriesId(c.req.param("id")), sequel), 201));
  }
  app.post("/series/:id/archive", async c => {
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.archive(c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision);
    return c.json({ ok: true });
  });
  app.delete("/series/:id", async c => {
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.remove(c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision);
    return c.json({ ok: true });
  });
  app.put("/series/:id/script", async c => {
    const input = comicDramaScriptWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.saveScript(c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision, input.data.content));
  });
  app.post("/series/:id/clips", async c => {
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.addClip(c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision), 201);
  });
  app.put("/series/:id/clips/order", async c => {
    const input = reorderComicDramaClipsSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.reorder(c.get("userId"), seriesId(c.req.param("id")), input.data));
  });
  app.patch("/series/:id/clips/:clipId", async c => {
    const input = updateComicDramaClipSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.saveClip(c.get("userId"), seriesId(c.req.param("id")), seriesId(c.req.param("clipId")), input.data));
  });
  app.post("/series/:id/clips/:clipId/copy", async c => {
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const id = seriesId(c.req.param("id")), clipId = seriesId(c.req.param("clipId"));
    return c.json(await repo.copyClip(c.get("userId"), id, clipId, input.data.expectedRevision), 201);
  });
  app.delete("/series/:id/clips/:clipId", async c => {
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const id = seriesId(c.req.param("id")), clipId = seriesId(c.req.param("clipId"));
    return c.json(await repo.removeClip(c.get("userId"), id, clipId, input.data.expectedRevision));
  });
  return app;
}
