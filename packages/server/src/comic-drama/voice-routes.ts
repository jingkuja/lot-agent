import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  COMIC_VOICE_SAMPLE_BYTES, comicCharacterVoiceDesignInput, comicLibraryVoiceArchiveSchema, comicLibraryVoiceCreateSchema,
  comicLibraryVoiceIdSchema, comicLibraryVoiceListSchema,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing } from "./library-db.js";
import type { ComicDirectorLlm } from "./director-model.js";
import type { ComicVoices } from "./voices.js";

export function createComicVoiceRoutes(voices: ComicVoices, accepting: () => void, resolveModel?: (owner: string) => Promise<ComicDirectorLlm>) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.onError((error, c) => {
    if (error instanceof ComicLibraryError) return c.json({ code: error.code }, error.status);
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });
  const id = (value: string) => {
    const parsed = comicLibraryVoiceIdSchema.safeParse(value);
    return parsed.success ? parsed.data : libraryMissing();
  };
  app.get("/voices", async c => {
    c.header("Cache-Control", "private, no-store");
    const input = comicLibraryVoiceListSchema.safeParse(c.req.query());
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const { query, archived, page } = input.data;
    return c.json(await voices.list(c.get("userId"), query, archived === "true", page));
  });
  app.get("/voices/choices", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await voices.dialogueChoices(c.get("userId")));
  });
  const uploadLimit = bodyLimit({ maxSize: COMIC_VOICE_SAMPLE_BYTES + 64 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  app.post("/voices", uploadLimit, async c => {
    const form = await c.req.formData().catch(() => null);
    const fields = form?.get("fields");
    if (typeof fields !== "string" || fields.length > 4096) return c.json({ code: "INVALID_INPUT" }, 400);
    let parsed: unknown;
    try { parsed = JSON.parse(fields); }
    catch { return c.json({ code: "INVALID_INPUT" }, 400); }
    const input = comicLibraryVoiceCreateSchema.safeParse(parsed);
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const sample = form?.get("sample");
    return c.json(await voices.create(c.get("userId"), input.data, sample instanceof File ? sample : undefined, c.req.raw.signal, accepting), 201);
  });
  if (resolveModel) {
    const designLimit = bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
    app.post("/voices/character-design", designLimit, async c => {
      c.header("Cache-Control", "private, no-store");
      const input = comicCharacterVoiceDesignInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
      return c.json(await voices.designCharacter(c.get("userId"), input.data, c.req.raw.signal, accepting, resolveModel), 201);
    });
    app.post("/voices/character-design/:id/refresh", async c => {
      c.header("Cache-Control", "private, no-store");
      return c.json(await voices.refreshCharacterDesign(c.get("userId"), id(c.req.param("id")), c.req.raw.signal));
    });
  }
  app.post("/voices/:id/refresh", async c => c.json(await voices.refresh(c.get("userId"), id(c.req.param("id")), c.req.raw.signal)));
  app.patch("/voices/:id", bodyLimit({ maxSize: 4096, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) }), async c => {
    const input = comicLibraryVoiceArchiveSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await voices.archive(c.get("userId"), id(c.req.param("id")), input.data.archived);
    return c.json({ ok: true });
  });
  return app;
}
