import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  COMIC_SCRIPT_DOCX, COMIC_SCRIPT_FILE_BYTES, COMIC_SCRIPT_MAX_CHARS, comicDirectorApplySchema, comicDirectorInputSchema, comicDramaIdSchema,
} from "@lot-agent/core/comic-drama";
import { parseIsolated } from "../knowledge/ingestion/parser-process.js";
import type { ComicDirector } from "./director-agent.js";
import type { PgComicDirector } from "./director-repository.js";
import { ComicLibraryError, libraryMissing } from "./library-db.js";
import { ComicDramaError } from "./repository.js";

export function createComicDirectorRoutes(repo: PgComicDirector, director: ComicDirector, parser: string) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.onError((error, c) => {
    if (error instanceof ComicLibraryError) return c.json({ code: error.code }, error.status);
    if (error instanceof ComicDramaError) return c.json({ code: error.code, currentRevision: error.currentRevision },
      error.code === "NOT_FOUND" ? 404 : error.code === "REVISION_CONFLICT" ? 409 : 400);
    console.error("[comic-drama] director request failed", { path: c.req.routePath, errorType: error.name });
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });
  app.use("/series/:id/director/*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  const limit = bodyLimit({ maxSize: 160 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  const fileLimit = bodyLimit({ maxSize: COMIC_SCRIPT_FILE_BYTES, onError: c => c.json({ code: "DIRECTOR_FILE_TOO_LARGE" }, 413) });
  const id = (value: string) => {
    const result = comicDramaIdSchema.safeParse(value);
    return result.success ? result.data : libraryMissing();
  };
  app.get("/series/:id/director", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await repo.list(c.get("userId"), id(c.req.param("id"))));
  });
  app.post("/series/:id/director/import", fileLimit, async c => {
    const episode = await repo.episode(c.get("userId"), id(c.req.param("id")));
    if (episode.archived) throw new ComicLibraryError("DIRECTOR_ARCHIVED", 409);
    const mime = c.req.header("Content-Type")?.split(";", 1)[0].toLowerCase();
    if (mime !== "text/plain" && mime !== COMIC_SCRIPT_DOCX) throw new ComicLibraryError("DIRECTOR_FILE_TYPE", 415);
    const signal = c.req.raw.signal;
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const parsed = await parseIsolated(parser, { mime, bytes }, signal, 15_000).catch(() => {
      throw new ComicLibraryError("DIRECTOR_FILE_INVALID", 400);
    });
    const text = parsed.blocks.map(block => block.text).join("\n\n").replace(/\0/g, "").trim();
    if (!text) throw new ComicLibraryError("DIRECTOR_FILE_INVALID", 400);
    return c.json({ text: text.slice(0, COMIC_SCRIPT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/u, ""), truncated: text.length > COMIC_SCRIPT_MAX_CHARS });
  });
  app.post("/series/:id/director/proposals", limit, async c => {
    const fields = comicDirectorInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!fields.success) throw new ComicLibraryError("INVALID_INPUT", 400);
    const result = await director.write(c.get("userId"), id(c.req.param("id")), fields.data, c.req.raw.signal);
    return c.json(result, result.status === "writing" ? 202 : 200);
  });
  app.post("/series/:id/director/proposals/:proposalId/apply", limit, async c => {
    const fields = comicDirectorApplySchema.safeParse(await c.req.json().catch(() => null));
    if (!fields.success) throw new ComicLibraryError("INVALID_INPUT", 400);
    return c.json(await repo.decide(c.get("userId"), id(c.req.param("id")), id(c.req.param("proposalId")), fields.data.expectedRevision));
  });
  app.post("/series/:id/director/proposals/:proposalId/dismiss", async c =>
    c.json(await repo.decide(c.get("userId"), id(c.req.param("id")), id(c.req.param("proposalId")))));
  return app;
}
