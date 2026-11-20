import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  comicCharacterInput, comicCharacterUpload, comicDictionaryCreate, comicDictionaryDomain, comicDictionaryOrder, comicDictionaryUpdate,
  comicDramaIdSchema, comicLibrarySearch, comicMaterialInput, comicMaterialSearch, comicMaterialUpdate, comicOutfitInput, comicOutfitOrder,
  comicSaveMediaAsMaterial, comicStyleReferenceBindSchema, comicUserPreferencesSchema,
  type ComicDictionaryRepository, type ComicLibraryRepository,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing } from "./library-db.js";
import type { ComicMediaLibrary } from "./media-library.js";
import type { PgComicSettings } from "./settings-repository.js";

type Variables = { userId: string };

export function createComicLibraryRoutes(
  repo: ComicLibraryRepository, dictionary: ComicDictionaryRepository, files: ComicMediaLibrary, settings?: PgComicSettings,
) {
  const app = new Hono<{ Variables: Variables }>();
  const limitJson = bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  for (const resource of ["characters", "materials", "dictionary", "media", "settings"]) {
    app.use(`/${resource}/*`, async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      const rawUpload = c.req.method === "POST" && (c.req.path.endsWith("/files") || c.req.path.endsWith("/upload"));
      return rawUpload ? next() : limitJson(c, next);
    });
  }
  app.onError((error, c) => {
    if (error instanceof ComicLibraryError) return c.json({ code: error.code }, error.status);
    console.error("[comic-drama] library request failed", { path: c.req.routePath, errorType: error.name });
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });
  const id = (input: string) => {
    const parsed = comicDramaIdSchema.safeParse(input);
    if (!parsed.success) libraryMissing();
    return parsed.data;
  };
  const domain = (input: string) => {
    const parsed = comicDictionaryDomain.safeParse(input);
    if (!parsed.success) libraryMissing();
    return parsed.data;
  };

  app.get("/characters", async c => {
    const query = comicLibrarySearch.safeParse(c.req.query());
    if (!query.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.listCharacters(c.get("userId"), query.data));
  });
  app.post("/characters", async c => {
    const data = comicCharacterInput.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json({ id: await repo.createCharacter(c.get("userId"), data.data) }, 201);
  });
  app.get("/characters/:id", async c => c.json(await repo.getCharacter(c.get("userId"), id(c.req.param("id")))));
  app.patch("/characters/:id", async c => {
    const data = comicCharacterInput.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.editCharacter(c.get("userId"), id(c.req.param("id")), data.data);
    return c.json({ ok: true });
  });
  app.post("/characters/:id/archive", async c => {
    await repo.archiveCharacter(c.get("userId"), id(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/characters/:id/outfits", async c => {
    const data = comicOutfitInput.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.addOutfit(c.get("userId"), id(c.req.param("id")), data.data.name), 201);
  });
  app.put("/characters/:id/outfits/order", async c => {
    if (!repo.reorderOutfits) return c.json({ code: "NOT_FOUND" }, 404);
    const data = comicOutfitOrder.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.reorderOutfits(c.get("userId"), id(c.req.param("id")), data.data.outfitIds));
  });
  app.patch("/characters/:id/outfits/:outfitId", async c => {
    if (!repo.renameOutfit) return c.json({ code: "NOT_FOUND" }, 404);
    const data = comicOutfitInput.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.renameOutfit(c.get("userId"), id(c.req.param("id")), id(c.req.param("outfitId")), data.data.name));
  });
  app.delete("/characters/:id/outfits/:outfitId", async c => {
    if (!repo.deleteOutfit) return c.json({ code: "NOT_FOUND" }, 404);
    await repo.deleteOutfit(c.get("userId"), id(c.req.param("id")), id(c.req.param("outfitId")));
    return c.json({ ok: true });
  });
  app.delete("/characters/:id/assets", async c => {
    if (!repo.deleteCharacterAsset) return c.json({ code: "NOT_FOUND" }, 404);
    const body = await c.req.json().catch(() => null);
    const data = comicCharacterUpload.safeParse(body ?? c.req.query());
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.deleteCharacterAsset(c.get("userId"), id(c.req.param("id")), data.data);
    return c.json({ ok: true });
  });
  app.get("/characters/:id/versions", async c => {
    const data = comicCharacterUpload.safeParse(c.req.query());
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.characterVersions(c.get("userId"), id(c.req.param("id")), data.data));
  });
  app.post("/characters/:id/files", async c => {
    const data = comicCharacterUpload.safeParse(c.req.query());
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId"), character = id(c.req.param("id"));
    await repo.validateCharacterAsset(owner, character, data.data);
    return c.json(await files.upload(c.req.raw, owner, "character", async media =>
      ({ version: await repo.addCharacterAsset(owner, character, data.data, media), mediaId: media.id })), 201);
  });

  app.get("/materials", async c => {
    const query = comicMaterialSearch.safeParse(c.req.query());
    if (!query.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await repo.listMaterials(c.get("userId"), query.data));
  });
  app.post("/materials/upload", async c => {
    const { tags, categoryKey, ...query } = c.req.query();
    const values = tags?.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) ?? [];
    const data = comicMaterialInput.safeParse({ ...query, categoryKey: categoryKey || null, tags: values });
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    return c.json(await files.upload(c.req.raw, owner, data.data.kind, async media =>
      ({ id: await repo.addMaterial(owner, data.data, media), mediaId: media.id })), 201);
  });
  app.post("/materials/from-media", async c => {
    if (!repo.addMaterialFromMedia) return c.json({ code: "NOT_FOUND" }, 404);
    const data = comicSaveMediaAsMaterial.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json({ id: await repo.addMaterialFromMedia(c.get("userId"), data.data.material, data.data.mediaId) }, 201);
  });
  app.patch("/materials/:id", async c => {
    if (!repo.editMaterial) return c.json({ code: "NOT_FOUND" }, 404);
    const data = comicMaterialUpdate.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.editMaterial(c.get("userId"), id(c.req.param("id")), data.data);
    return c.json({ ok: true });
  });
  app.post("/materials/:id/files", async c => {
    const owner = c.get("userId"), material = id(c.req.param("id"));
    const { kind } = await repo.materialInput(owner, material);
    return c.json(await files.upload(c.req.raw, owner, kind, async media =>
      ({ version: await repo.replaceMaterial(owner, material, media), mediaId: media.id })), 201);
  });
  app.get("/materials/:id/versions", async c => c.json(await repo.materialVersions(c.get("userId"), id(c.req.param("id")))));
  app.post("/materials/:id/archive", async c => {
    await repo.archiveMaterial(c.get("userId"), id(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/materials/:id/unarchive", async c => {
    if (!repo.unarchiveMaterial) return c.json({ code: "NOT_FOUND" }, 404);
    await repo.unarchiveMaterial(c.get("userId"), id(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.delete("/materials/:id", async c => {
    if (!repo.deleteMaterial) return c.json({ code: "NOT_FOUND" }, 404);
    await repo.deleteMaterial(c.get("userId"), id(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.get("/media/:id/links", async c => c.json(await files.links(c.get("userId"), id(c.req.param("id")))));

  if (settings) {
    app.get("/settings", async c => {
      c.header("Cache-Control", "private, no-store");
      return c.json(await settings.getAll(c.get("userId")));
    });
    app.put("/settings", async c => {
      const data = comicUserPreferencesSchema.safeParse(await c.req.json().catch(() => null));
      if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
      return c.json(await settings.updatePreferences(c.get("userId"), data.data));
    });
    app.put("/settings/styles/:styleKey/reference", async c => {
      const data = comicStyleReferenceBindSchema.safeParse(await c.req.json().catch(() => null));
      if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
      return c.json(await settings.bindStylePreset(c.get("userId"), c.req.param("styleKey"), data.data.mediaId));
    });
    app.post("/settings/styles/:styleKey/reference/upload", async c => {
      const owner = c.get("userId"), styleKey = c.req.param("styleKey");
      return c.json(await files.upload(c.req.raw, owner, "scene", media => settings.uploadStylePreset(owner, styleKey, media)), 201);
    });
    app.delete("/settings/styles/:styleKey/reference", async c => {
      await settings.removeStylePreset(c.get("userId"), c.req.param("styleKey"));
      return c.json({ ok: true });
    });
  }

  app.get("/dictionary/:domain", async c => c.json(await dictionary.dictionary(c.get("userId"), domain(c.req.param("domain")))));
  app.post("/dictionary/:domain", async c => {
    const data = comicDictionaryCreate.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await dictionary.addDictionary(c.get("userId"), domain(c.req.param("domain")), data.data.key, data.data.labels), 201);
  });
  app.put("/dictionary/:domain/order", async c => {
    const data = comicDictionaryOrder.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await dictionary.sortDictionary(c.get("userId"), domain(c.req.param("domain")), data.data.keys));
  });
  app.patch("/dictionary/:domain/:key", async c => {
    const data = comicDictionaryUpdate.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json(await dictionary.editDictionary(c.get("userId"), domain(c.req.param("domain")), c.req.param("key"), data.data));
  });
  return app;
}
