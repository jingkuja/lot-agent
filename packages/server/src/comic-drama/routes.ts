import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  COMIC_DRAMA_SCRIPT_MAX_CHARS, COMIC_SCRIPT_DOCX, COMIC_SCRIPT_FILE_BYTES, comicAddClipSchema, comicCastAddSchema,
  comicCastOutfitSchema, comicDramaIdSchema, comicDramaListSchema, comicDramaMasterScriptWriteSchema,
  comicDramaOutlineWriteSchema, comicDramaRevisionSchema, comicDramaScriptWriteSchema, comicDramaSeriesListSchema,
  comicDramaSetCurrentDramaSchema, comicDramaSetCurrentSchema, comicSequelOptionsSchema, comicVideoProfile,
  createComicDramaSchema, createComicDramaSeriesSchema, createComicEpisodeSchema, reorderComicDramaClipsSchema,
  updateComicDramaClipSchema, updateComicDramaSchema, updateComicDramaSeriesSchema, type ComicDramaRepository,
} from "@lot-agent/core/comic-drama";
import { parseIsolated } from "../knowledge/ingestion/parser-process.js";
import { ComicLibraryError } from "./library-db.js";
import { ComicDramaError } from "./repository.js";

type Variables = { userId: string };

export function createComicDramaRoutes(
  repo: ComicDramaRepository,
  canSelectModel: (owner: string, model: string) => Promise<boolean>,
  resolveDefaultVideoModel?: (owner: string) => Promise<string | null>,
  parser?: string,
) {
  const app = new Hono<{ Variables: Variables }>();
  const jsonLimit = bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  const fileLimit = bodyLimit({ maxSize: COMIC_SCRIPT_FILE_BYTES, onError: c => c.json({ code: "DIRECTOR_FILE_TOO_LARGE" }, 413) });
  app.use("/series/*", jsonLimit);
  app.use("/dramas", jsonLimit);
  app.use("/dramas/*", async (c, next) => {
    if (c.req.path.endsWith("/import")) return next();
    return jsonLimit(c, next);
  });
  app.onError((error, c) => {
    if (error instanceof ComicLibraryError) return c.json({ code: error.code }, error.status);
    if (error instanceof ComicDramaError) {
      if (error.code === "REVISION_CONFLICT") return c.json({ code: error.code, currentRevision: error.currentRevision }, 409);
      return c.json({ code: error.code }, error.code === "NOT_FOUND" ? 404 : 400);
    }
    console.error("[comic-drama] workspace request failed", { path: c.req.routePath, errorType: error.name });
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });
  const seriesId = (value: string | undefined) => {
    const parsed = comicDramaIdSchema.safeParse(value);
    if (!parsed.success) throw new ComicDramaError("NOT_FOUND");
    return parsed.data;
  };
  const resolveVideoModelForCreate = async (owner: string, requested: string | null | undefined) => {
    let videoModel = requested ?? null;
    if (videoModel) {
      if (!comicVideoProfile(videoModel) || !await canSelectModel(owner, videoModel)) {
        return { ok: false as const };
      }
      return { ok: true as const, videoModel };
    }
    if (resolveDefaultVideoModel) {
      const candidate = await resolveDefaultVideoModel(owner).catch(() => null);
      if (candidate && comicVideoProfile(candidate) && await canSelectModel(owner, candidate)) {
        videoModel = candidate;
      }
    }
    return { ok: true as const, videoModel };
  };

  app.get("/dramas", async c => {
    if (!repo.listDramas) return c.json({ dramas: [], nextCursor: null });
    const input = comicDramaListSchema.safeParse(c.req.query());
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.listDramas(c.get("userId"), input.data));
  });
  app.post("/dramas", async c => {
    if (!repo.createDrama) return c.json({ code: "NOT_FOUND" }, 404);
    const input = createComicDramaSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    const resolved = await resolveVideoModelForCreate(owner, input.data.videoModel);
    if (!resolved.ok) return c.json({ code: "MODEL_UNAVAILABLE" }, 400);
    return c.json(await repo.createDrama(owner, { ...input.data, videoModel: resolved.videoModel }), 201);
  });
  app.get("/dramas/current", async c => {
    if (!repo.currentDrama) {
      return c.json({ dramaId: null, seriesId: null, drama: null, episodeCount: 0, castCount: 0 });
    }
    return c.json(await repo.currentDrama(c.get("userId")));
  });
  app.put("/dramas/current", async c => {
    if (!repo.openDrama) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicDramaSetCurrentDramaSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.openDrama(c.get("userId"), input.data.dramaId));
  });
  app.get("/dramas/:dramaId", async c => {
    if (!repo.getDrama) return c.json({ code: "NOT_FOUND" }, 404);
    return c.json(await repo.getDrama(c.get("userId"), seriesId(c.req.param("dramaId"))));
  });
  app.patch("/dramas/:dramaId", async c => {
    if (!repo.updateDrama || !repo.getDrama) return c.json({ code: "NOT_FOUND" }, 404);
    const input = updateComicDramaSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    const dramaId = seriesId(c.req.param("dramaId"));
    const { videoModel } = input.data;
    if (videoModel && videoModel !== (await repo.getDrama(owner, dramaId)).drama.videoModel
      && (!comicVideoProfile(videoModel) || !await canSelectModel(owner, videoModel))) {
      return c.json({ code: "MODEL_UNAVAILABLE" }, 400);
    }
    return c.json(await repo.updateDrama(owner, dramaId, input.data));
  });
  app.put("/dramas/:dramaId/outline", async c => {
    if (!repo.saveDramaOutline) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicDramaOutlineWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.saveDramaOutline(
      c.get("userId"), seriesId(c.req.param("dramaId")), input.data.expectedRevision, input.data.outline,
    ));
  });
  app.put("/dramas/:dramaId/script", async c => {
    if (!repo.saveDramaScript) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicDramaMasterScriptWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.saveDramaScript(
      c.get("userId"), seriesId(c.req.param("dramaId")), input.data.expectedRevision, input.data.content,
    ));
  });
  app.post("/dramas/:dramaId/import", fileLimit, async c => {
    if (!repo.getDrama || !parser) return c.json({ code: "NOT_FOUND" }, 404);
    const { drama } = await repo.getDrama(c.get("userId"), seriesId(c.req.param("dramaId")));
    if (drama.archivedAt) throw new ComicLibraryError("DIRECTOR_ARCHIVED", 409);
    const mime = c.req.header("Content-Type")?.split(";", 1)[0].toLowerCase();
    if (mime !== "text/plain" && mime !== COMIC_SCRIPT_DOCX) throw new ComicLibraryError("DIRECTOR_FILE_TYPE", 415);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const parsed = await parseIsolated(parser, { mime, bytes }, c.req.raw.signal, 15_000).catch(() => {
      throw new ComicLibraryError("DIRECTOR_FILE_INVALID", 400);
    });
    const text = parsed.blocks.map(block => block.text).join("\n\n").replace(/\0/g, "").trim();
    if (!text) throw new ComicLibraryError("DIRECTOR_FILE_INVALID", 400);
    return c.json({
      text: text.slice(0, COMIC_DRAMA_SCRIPT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/u, ""),
      truncated: text.length > COMIC_DRAMA_SCRIPT_MAX_CHARS,
    });
  });
  app.get("/dramas/:dramaId/cast", async c => {
    if (!repo.readDramaCast) return c.json({ code: "NOT_FOUND" }, 404);
    return c.json(await repo.readDramaCast(c.get("userId"), seriesId(c.req.param("dramaId"))));
  });
  app.post("/dramas/:dramaId/cast", async c => {
    if (!repo.changeDramaCast) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicCastAddSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const { expectedRevision, characterId, outfitId } = input.data;
    return c.json(await repo.changeDramaCast(c.get("userId"), seriesId(c.req.param("dramaId")), expectedRevision,
      { action: "add", characterId, outfitId }), 201);
  });
  app.patch("/dramas/:dramaId/cast/:characterId", async c => {
    if (!repo.changeDramaCast) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicCastOutfitSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const characterId = seriesId(c.req.param("characterId"));
    return c.json(await repo.changeDramaCast(c.get("userId"), seriesId(c.req.param("dramaId")), input.data.expectedRevision,
      { action: "outfit", characterId, outfitId: input.data.outfitId }));
  });
  for (const [method, suffix, action] of [["POST", "/sync", "sync"], ["DELETE", "", "remove"]] as const) {
    app.on(method, "/dramas/:dramaId/cast/:characterId" + suffix, async c => {
      if (!repo.changeDramaCast) return c.json({ code: "NOT_FOUND" }, 404);
      const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
      const characterId = seriesId(c.req.param("characterId"));
      return c.json(await repo.changeDramaCast(
        c.get("userId"), seriesId(c.req.param("dramaId")), input.data.expectedRevision, { action, characterId },
      ));
    });
  }
  app.post("/dramas/:dramaId/episodes", async c => {
    if (!repo.createEpisode) return c.json({ code: "NOT_FOUND" }, 404);
    const input = createComicEpisodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    const dramaId = seriesId(c.req.param("dramaId"));
    let videoModel = input.data.videoModel;
    if (videoModel !== undefined) {
      if (videoModel && (!comicVideoProfile(videoModel) || !await canSelectModel(owner, videoModel))) {
        return c.json({ code: "MODEL_UNAVAILABLE" }, 400);
      }
    } else if (resolveDefaultVideoModel) {
      const candidate = await resolveDefaultVideoModel(owner).catch(() => null);
      if (candidate && comicVideoProfile(candidate) && await canSelectModel(owner, candidate)) {
        videoModel = candidate;
      }
    }
    return c.json(await repo.createEpisode(owner, dramaId, { ...input.data, ...(videoModel !== undefined ? { videoModel } : {}) }), 201);
  });
  app.post("/dramas/:dramaId/archive", async c => {
    if (!repo.archiveDrama) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.archiveDrama(c.get("userId"), seriesId(c.req.param("dramaId")), input.data.expectedRevision);
    return c.json({ ok: true });
  });
  app.delete("/dramas/:dramaId", async c => {
    if (!repo.removeDrama) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.removeDrama(c.get("userId"), seriesId(c.req.param("dramaId")), input.data.expectedRevision);
    return c.json({ ok: true });
  });

  app.get("/series", async c => {
    const input = comicDramaSeriesListSchema.safeParse(c.req.query());
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.list(c.get("userId"), input.data));
  });
  app.post("/series", async c => {
    const input = createComicDramaSeriesSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    const resolved = await resolveVideoModelForCreate(owner, input.data.videoModel);
    if (!resolved.ok) return c.json({ code: "MODEL_UNAVAILABLE" }, 400);
    return c.json(await repo.create(owner, { ...input.data, videoModel: resolved.videoModel }), 201);
  });
  app.get("/series/current", async c => {
    if (c.req.query("summary") === "1" && repo.currentSummary) {
      return c.json(await repo.currentSummary(c.get("userId")));
    }
    return c.json({ seriesId: await repo.current(c.get("userId")) });
  });
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
    if (videoModel && videoModel !== (await repo.get(owner, id)).series.videoModel
      && (!comicVideoProfile(videoModel) || !await canSelectModel(owner, videoModel))) {
      return c.json({ code: "MODEL_UNAVAILABLE" }, 400);
    }
    return c.json(await repo.update(owner, id, input.data));
  });
  app.post("/series/:id/copy", async c => c.json(await repo.derive(c.get("userId"), seriesId(c.req.param("id")), false), 201));
  app.post("/series/:id/sequel", async c => {
    const body = await c.req.text();
    let options: unknown;
    try { options = body ? JSON.parse(body) : {}; }
    catch { return c.json({ code: "INVALID_INPUT" }, 400); }
    const input = comicSequelOptionsSchema.safeParse(options);
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.derive(c.get("userId"), seriesId(c.req.param("id")), true, input.data.inheritCastAndStyle), 201);
  });
  app.get("/series/:id/cast", async c => c.json(await repo.readCast(c.get("userId"), seriesId(c.req.param("id")))));
  app.post("/series/:id/cast", async c => {
    const input = comicCastAddSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const { expectedRevision, characterId, outfitId } = input.data;
    return c.json(await repo.changeCast(c.get("userId"), seriesId(c.req.param("id")), expectedRevision,
      { action: "add", characterId, outfitId }), 201);
  });
  app.post("/series/:id/cast/sync-drama", async c => {
    if (!repo.syncEpisodeCastFromDrama) return c.json({ code: "NOT_FOUND" }, 404);
    const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.syncEpisodeCastFromDrama(
      c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision,
    ));
  });
  app.patch("/series/:id/cast/:characterId", async c => {
    const input = comicCastOutfitSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const characterId = seriesId(c.req.param("characterId"));
    return c.json(await repo.changeCast(c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision,
      { action: "outfit", characterId, outfitId: input.data.outfitId }));
  });
  for (const [method, suffix, action] of [["POST", "/sync", "sync"], ["DELETE", "", "remove"]] as const) {
    app.on(method, "/series/:id/cast/:characterId" + suffix, async c => {
      const input = comicDramaRevisionSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
      const characterId = seriesId(c.req.param("characterId"));
      return c.json(await repo.changeCast(c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision, { action, characterId }));
    });
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
  app.get("/series/:id/script", async c => {
    if (!repo.scriptHistory) return c.json({ versions: [] });
    return c.json({ versions: await repo.scriptHistory(c.get("userId"), seriesId(c.req.param("id"))) });
  });
  app.put("/series/:id/script", async c => {
    const input = comicDramaScriptWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.saveScript(c.get("userId"), seriesId(c.req.param("id")), input.data.expectedRevision, input.data.content));
  });
  app.post("/series/:id/clips", async c => {
    const input = comicAddClipSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const { expectedRevision, afterClipId, insertIndex } = input.data;
    return c.json(await repo.addClip(c.get("userId"), seriesId(c.req.param("id")), expectedRevision, { afterClipId, insertIndex }), 201);
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
