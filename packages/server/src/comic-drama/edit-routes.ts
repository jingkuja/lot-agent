import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  comicDramaEditOpenSchema, comicDramaEditSyncSchema, comicDramaIdSchema, comicEditAppendSourceSchema,
  comicEditAutoDialoguePreviewSchema, comicEditAutoDialogueSchema, comicEditCreateSchema, comicEditDeleteSchema,
  comicEditListSchema, comicEditReplaceSchema, comicEditUpdateSchema, comicSpeechReleaseSchema, comicSpeechRequestSchema,
  comicVoiceAuditionReleaseSchema, comicVoiceAuditionSchema, comicVoiceBindSchema,
} from "@lot-agent/core/comic-drama";
import { ComicEditConflict, type PgComicEdits } from "./edit-repository.js";
import { ComicLibraryError, libraryMissing } from "./library-db.js";
import type { ComicEditSpeech } from "./edit-speech.js";

export function createComicEditRoutes(repo: PgComicEdits, speech: ComicEditSpeech, accepting?: () => void) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.onError((error, c) => {
    if (error instanceof ComicEditConflict) return c.json({ code: error.code, currentRevision: error.currentRevision }, 409);
    if (error instanceof ComicLibraryError) return c.json({ code: error.code }, error.status);
    console.error("[comic-drama] edit request failed", { path: c.req.routePath, errorType: error.name });
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });
  const limit = bodyLimit({ maxSize: 512 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  const id = (value: string) => {
    const parsed = comicDramaIdSchema.safeParse(value);
    return parsed.success ? parsed.data : libraryMissing();
  };
  app.get("/dramas/:dramaId/edit", async c => {
    c.header("Cache-Control", "private, no-store");
    const rawSeries = c.req.query("seriesId");
    const parsedSeries = rawSeries ? comicDramaIdSchema.safeParse(rawSeries) : null;
    if (parsedSeries && !parsedSeries.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.getDramaTask(c.get("userId"), id(c.req.param("dramaId")), parsedSeries?.data));
  });
  app.post("/dramas/:dramaId/edit/open", limit, async c => {
    const raw = await c.req.text();
    let parsedBody: unknown = {};
    if (raw) {
      try { parsedBody = JSON.parse(raw); }
      catch { return c.json({ code: "INVALID_INPUT" }, 400); }
    }
    const input = comicDramaEditOpenSchema.safeParse(parsedBody);
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.openDramaTask(c.get("userId"), id(c.req.param("dramaId")), input.data.seriesId));
  });
  app.get("/edits", async c => {
    c.header("Cache-Control", "private, no-store");
    const query = comicEditListSchema.safeParse(c.req.query());
    if (!query.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.list(c.get("userId"), query.data.cursor));
  });
  app.post("/edits", limit, async c => {
    const input = comicEditCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.create(c.get("userId"), input.data), 201);
  });
  app.get("/edits/:id", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await repo.get(c.get("userId"), id(c.req.param("id"))));
  });
  app.patch("/edits/:id", limit, async c => {
    const input = comicEditUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_TIMELINE" }, 400);
    return c.json(await repo.update(c.get("userId"), id(c.req.param("id")), input.data));
  });
  app.delete("/edits/:id", limit, async c => {
    const input = comicEditDeleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.remove(c.get("userId"), id(c.req.param("id")), input.data.expectedRevision);
    return c.json({ ok: true });
  });
  app.post("/edits/:id/items/:itemId/replace", limit, async c => {
    const input = comicEditReplaceSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.replace(c.get("userId"), id(c.req.param("id")), id(c.req.param("itemId")), input.data));
  });
  app.post("/edits/:id/append-source", limit, async c => {
    const input = comicEditAppendSourceSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.appendSource(c.get("userId"), id(c.req.param("id")), input.data));
  });
  app.post("/edits/:id/sync-episode", limit, async c => {
    const input = comicDramaEditSyncSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.syncEpisodeSources(c.get("userId"), id(c.req.param("id")), input.data.expectedRevision));
  });
  app.post("/edits/:id/auto-dialogue/preview", limit, async c => {
    const input = comicEditAutoDialoguePreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await speech.previewAutoDialogue(c.get("userId"), id(c.req.param("id")), input.data));
  });
  app.post("/edits/:id/auto-dialogue", limit, async c => {
    const input = comicEditAutoDialogueSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await speech.autoDialogue(c.get("userId"), id(c.req.param("id")), input.data, c.req.raw.signal, accepting));
  });
  app.get("/characters/:id/voice", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await speech.settings(c.get("userId"), id(c.req.param("id"))));
  });
  app.put("/characters/:id/voice", limit, async c => {
    const input = comicVoiceBindSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await speech.bind(c.get("userId"), id(c.req.param("id")), input.data);
    return c.json({ ok: true });
  });
  app.post("/characters/:id/voice/audition", limit, async c => {
    const raw = await c.req.json().catch(() => null);
    const body = raw && typeof raw === "object" && !("voice" in raw)
      ? { ...(raw as Record<string, unknown>), voice: { kind: "character", characterId: id(c.req.param("id")) } }
      : raw;
    const input = comicVoiceAuditionSchema.safeParse(body);
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await speech.audition(c.get("userId"), input.data, c.req.raw.signal, accepting));
  });
  app.post("/characters/:id/voice/audition/release", limit, async c => {
    const raw = await c.req.json().catch(() => null);
    const body = raw && typeof raw === "object" && !("voice" in raw)
      ? { ...(raw as Record<string, unknown>), voice: { kind: "character", characterId: id(c.req.param("id")) } }
      : raw;
    const input = comicVoiceAuditionReleaseSchema.safeParse(body);
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await speech.releaseAudition(c.get("userId"), input.data);
    return c.json({ ok: true });
  });
  app.post("/voices/audition", limit, async c => {
    const input = comicVoiceAuditionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await speech.audition(c.get("userId"), input.data, c.req.raw.signal, accepting));
  });
  app.post("/voices/audition/release", limit, async c => {
    const input = comicVoiceAuditionReleaseSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await speech.releaseAudition(c.get("userId"), input.data);
    return c.json({ ok: true });
  });
  app.get("/edits/:id/items/:itemId/lines", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await speech.lines(c.get("userId"), id(c.req.param("id")), id(c.req.param("itemId"))));
  });
  app.post("/edits/:id/items/:itemId/lines/:lineId/speech", limit, async c => {
    const input = comicSpeechRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const data = await speech.speak(c.get("userId"), id(c.req.param("id")), id(c.req.param("itemId")), id(c.req.param("lineId")),
      input.data, c.req.raw.signal, accepting);
    return c.json(data);
  });
  app.post("/edits/:id/items/:itemId/lines/:lineId/speech/release", limit, async c => {
    const input = comicSpeechReleaseSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await speech.release(c.get("userId"), id(c.req.param("id")), id(c.req.param("itemId")), id(c.req.param("lineId")), input.data);
    return c.json({ ok: true });
  });
  return app;
}
