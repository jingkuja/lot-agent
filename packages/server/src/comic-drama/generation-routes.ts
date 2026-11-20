import { Hono } from "hono";
import { PgComicDirector } from "./director-repository.js";
import { bodyLimit } from "hono/body-limit";
import type { Pool } from "pg";
import { MAX_IMAGE_EDIT_REFERENCES } from "@lot-agent/core";
import {
  buildComicGenerationInput, comicCharacterGenerateSchema, comicDramaIdSchema, comicDramaRevisionSchema, comicGenerationConfirmSchema,
  comicGenerationPreviewSchema, comicKeyframeReviewSchema, comicKeyframeSelectSchema, comicTakeReleaseSchema, comicVideoProfile,
  type ComicCharacterGenerateRequest, type ComicCharacterUpload, type ComicGenerationPreviewRequest, type ComicGenerationImage,
  type ComicGenerationQuote, type ComicGenerationReference, type ComicImageTakeInput, type ComicTakeInput,
} from "@lot-agent/core/comic-drama";
import { COMIC_IMAGE_TASK } from "../jobs/task-queues.js";
import { assertComicDramaCompliance } from "./compliance.js";
import { readComicDictionary } from "./dictionary.js";
import { type ComicGenerationScope, type ComicPrice, type FrozenVisualReference, PgComicGeneration } from "./generation-repository.js";
import { ComicLibraryError, libraryMissing, libraryTransaction } from "./library-db.js";
import type { PgComicLibrary } from "./library-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";
import { ComicDramaError, type PgComicDramaRepository } from "./repository.js";
import { PgComicSettings } from "./settings-repository.js";
import { PgComicVideo } from "./video-repository.js";
import { createComicVideoRoutes } from "./video-routes.js";

export type GenerationQueue = {
  publishNewTask(id: string, type: string): Promise<void>;
  canResumePersisted(id: string): Promise<boolean>;
  resumePersisted(id: string, type: string): Promise<void>;
};
type Dependencies = {
  pool: Pool;
  library: PgComicLibrary;
  series: PgComicDramaRepository;
  media: ComicMediaLibrary;
  quotePrice: (owner: string, model?: string) => Promise<ComicPrice | null>;
  quoteVideoPrice?: (owner: string, model: string) => Promise<ComicPrice | null>;
  queue: GenerationQueue;
  accepting?: () => void;
};

export function createComicGenerationRoutes(deps: Dependencies) {
  const { pool, library, series, media, quotePrice, queue } = deps;
  const repo = new PgComicGeneration(pool);
  const video = new PgComicVideo(pool);
  const settings = new PgComicSettings(pool);
  const director = new PgComicDirector(pool, series);
  const app = new Hono<{ Variables: { userId: string } }>();
  const limit = bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  app.onError((error, c) => {
    if (error instanceof ComicLibraryError) return c.json({ code: error.code }, error.status);
    if (error instanceof ComicDramaError && error.code === "NOT_FOUND") return c.json({ code: "NOT_FOUND" }, 404);
    console.error("[comic-drama] generation request failed", { path: c.req.routePath, errorType: error.name });
    return c.json({ code: "TEMPORARILY_UNAVAILABLE" }, 503);
  });

  const pathId = (value: string) => {
    const result = comicDramaIdSchema.safeParse(value);
    if (!result.success) libraryMissing();
    return result.data;
  };
  async function previewSeries(owner: string, scope: ComicGenerationScope, body: ComicGenerationPreviewRequest) {
    const detail = await series.get(owner, scope.id);
    if (detail.series.archivedAt) libraryMissing();
    if (detail.series.revision !== body.expectedSeriesRevision) throw new ComicLibraryError("QUOTE_STALE", 409);
    const clips = body.targets.map(target => {
      const clip = detail.clips.find(clip => clip.id === target.clipId);
      if (!clip || clip.revision !== target.expectedRevision) throw new ComicLibraryError("QUOTE_STALE", 409);
      return clip;
    });
    assertComicDramaCompliance([
      { field: "series.title", text: detail.series.title },
      { field: "series.logline", text: detail.series.logline },
      ...(detail.script ? [{ field: "script", text: detail.script.content }] : []),
      ...clips.flatMap(clip => [
        { field: "clip.scene", text: clip.draft.scene },
        ...clip.draft.shots.map(shot => ({ field: "clip.shot", text: shot.description })),
        ...clip.draft.lines.map(line => ({ field: "clip.line", text: line.text })),
      ]),
    ]);
    const isVideo = body.mode !== "keyframe";
    const videoModel = detail.series.videoModel;
    const explicitRefs = body.visualReferences ?? [];
    const persistedSpecs = clips.flatMap(clip => [
      ...(clip.draft.sceneRef ? [{ kind: "scene" as const, materialId: clip.draft.sceneRef.materialId, mediaId: clip.draft.sceneRef.mediaId }] : []),
      ...(clip.draft.propRefs ?? []).map(ref => ({ kind: "prop" as const, materialId: ref.materialId, mediaId: ref.mediaId })),
    ]);
    const uniquePersisted = [...new Map(persistedSpecs.map(ref => [`${ref.materialId}:${ref.mediaId}`, ref])).values()];
    const [price, styles, frames, explicitVisualRefs, persistedVisualRefs, stylePreset] = await Promise.all([
      isVideo ? videoModel && deps.quoteVideoPrice ? deps.quoteVideoPrice(owner, videoModel) : null : quotePrice(owner),
      readComicDictionary(pool, owner, "style"),
      isVideo ? video.frames(owner, scope.id, clips.map(clip => clip.id)) : null,
      video.references(owner, explicitRefs),
      uniquePersisted.length ? video.references(owner, uniquePersisted).catch(() => []) : Promise.resolve([]),
      explicitRefs.some(ref => ref.kind === "style") ? Promise.resolve(null) : settings.getStylePreset(owner, detail.series.styleKey),
    ]);
    const styleDescription = styles.find(entry => entry.key === detail.series.styleKey)?.labels.en;
    const styleRef: (ComicGenerationReference & { kind: "style" }) | null = stylePreset
      && (stylePreset.media.mime === "image/jpeg" || stylePreset.media.mime === "image/png" || stylePreset.media.mime === "image/webp")
      && stylePreset.media.width && stylePreset.media.height
      ? {
        mediaId: stylePreset.media.id, version: 1, mime: stylePreset.media.mime, sizeBytes: stylePreset.media.sizeBytes,
        width: stylePreset.media.width, height: stylePreset.media.height, kind: "style", label: styleDescription ?? detail.series.styleKey,
      } : null;
    const persistedByKey = new Map(persistedVisualRefs.map(ref => [`${ref.materialId}:${ref.mediaId}`, ref]));
    const inputs: ComicTakeInput[] = [];
    const skipped: ComicGenerationQuote["skipped"] = [];
    const replaceAdopted = body.targets.filter(target => target.replaceAdopted).map(target => target.clipId);
    const frozenVisualMap = new Map<string, FrozenVisualReference>();
    for (const ref of explicitVisualRefs) {
      frozenVisualMap.set(`${ref.materialId}:${ref.mediaId}`, { materialId: ref.materialId, mediaId: ref.mediaId, version: ref.version });
    }
    if (styleRef && stylePreset) {
      frozenVisualMap.set(`style:${stylePreset.styleKey}`, { materialId: null, mediaId: styleRef.mediaId, version: 1, styleKey: stylePreset.styleKey });
    }
    for (const clip of clips) {
      const versions = frames?.get(clip.id);
      if (versions?.adopted && !replaceAdopted.includes(clip.id)) { skipped.push({ clipId: clip.id, reason: "ALREADY_COMPLETE" }); continue; }
      const clipRefs: Array<ComicGenerationReference & { kind: "style" | "scene" | "prop" }> = [...explicitVisualRefs];
      const seenMedia = new Set(clipRefs.map(ref => ref.mediaId));
      const clipPersisted = [
        ...(clip.draft.sceneRef ? [clip.draft.sceneRef] : []),
        ...(clip.draft.propRefs ?? []),
      ];
      for (const ref of clipPersisted) {
        if (seenMedia.has(ref.mediaId)) continue;
        const resolved = persistedByKey.get(`${ref.materialId}:${ref.mediaId}`);
        if (resolved) {
          seenMedia.add(resolved.mediaId);
          clipRefs.push(resolved);
          frozenVisualMap.set(`${resolved.materialId}:${resolved.mediaId}`, {
            materialId: resolved.materialId, mediaId: resolved.mediaId, version: resolved.version,
          });
        }
      }
      if (styleRef && !seenMedia.has(styleRef.mediaId)) clipRefs.push(styleRef);
      const built = buildComicGenerationInput({ series: detail.series, clip, cast: detail.cast,
        modelId: isVideo ? videoModel ?? "" : price?.modelId ?? "unpriced",
        styleDescription, mode: body.mode, firstFrame: versions?.frame ?? undefined, visualReferences: clipRefs });
      if (!built.ok) {
        const reason = built.issues[0].code;
        const referenceLimit = reason === "REFERENCE_LIMIT" ? comicVideoProfile(videoModel)?.referenceImages.total : undefined;
        skipped.push({ clipId: clip.id, reason, ...(referenceLimit ? { referenceLimit } : {}) });
      } else if (!isVideo && built.input.references.length > MAX_IMAGE_EDIT_REFERENCES) {
        skipped.push({ clipId: clip.id, reason: "REFERENCE_LIMIT", referenceLimit: MAX_IMAGE_EDIT_REFERENCES });
      }
      else if (!isVideo && built.input.prompt.length > 24_000) skipped.push({ clipId: clip.id, reason: "PROMPT_TOO_LONG" });
      else inputs.push(built.input);
    }
    if (price && isVideo && inputs.some(input => input.references.length || ("firstFrame" in input && input.firstFrame))) media.assertVideoReferenceOrigin();
    return repo.quote(owner, scope, String(detail.series.revision), price, inputs, skipped, replaceAdopted, [...frozenVisualMap.values()]);
  }
  async function previewCharacter(owner: string, scope: ComicGenerationScope, req: ComicCharacterGenerateRequest) {
    const target: ComicCharacterUpload = req.kind === "slot"
      ? { kind: "slot", key: req.key, outfitId: req.outfitId }
      : { kind: "expression", key: req.key };
    const price = await quotePrice(owner);
    const stylePreset = req.styleKey ? await settings.getStylePreset(owner, req.styleKey) : null;
    const { stamp, input } = await libraryTransaction(pool, async db => {
      const stamp = await repo.characterStamp(db, owner, scope.id);
      await library.validateCharacterAsset(owner, scope.id, target, db);
      const role = await library.getCharacter(owner, scope.id, db);
      const [choices, styles] = await Promise.all([
        readComicDictionary(db, owner, target.kind),
        req.styleKey ? readComicDictionary(db, owner, "style") : Promise.resolve([]),
      ]);
      const label = choices.find(item => item.key === target.key)?.labels.en ?? target.key;
      const styleLabel = req.styleKey ? styles.find(item => item.key === req.styleKey)?.labels.en ?? req.styleKey : null;
      const outfit = target.kind === "slot" ? role.outfits.find(item => item.id === target.outfitId) : undefined;
      assertComicDramaCompliance([
        { field: "character.name", text: role.name },
        { field: "character.appearance", text: role.appearance },
        { field: "character.personality", text: role.personality },
        ...(outfit ? [{ field: "character.outfit", text: outfit.name }] : []),
      ]);
      const asset = ["face", "front"].flatMap(key => role.assets.filter(item => item.kind === "slot" && item.key === key
        && (!outfit || item.outfitId === outfit.id) && (target.kind !== "slot" || target.key !== key)))[0];
      const references: ComicGenerationImage[] = [];
      const seen = new Set<string>();
      const pushMedia = (item: { id: string; mime: string; sizeBytes: number; width: number | null; height: number | null }, version = 1) => {
        if (seen.has(item.id) || references.length >= MAX_IMAGE_EDIT_REFERENCES) return;
        if ((item.mime === "image/jpeg" || item.mime === "image/png" || item.mime === "image/webp") && item.width && item.height) {
          seen.add(item.id);
          references.push({ mediaId: item.id, mime: item.mime, sizeBytes: item.sizeBytes, width: item.width, height: item.height, version });
        }
      };
      if (asset) pushMedia(asset.media, asset.version);
      if (stylePreset) pushMedia(stylePreset.media, 1);
      if (req.referenceMediaIds?.length) {
        const { rows: extraMedia } = await db.query<{ id: string; mime: string; sizeBytes: number; width: number | null; height: number | null }>(
          `SELECT id, mime, size_bytes AS "sizeBytes", width, height FROM lot_comic_drama.cd_media WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
          [owner, req.referenceMediaIds],
        );
        for (const extraId of req.referenceMediaIds) {
          const found = extraMedia.find(item => item.id === extraId);
          if (!found) throw new ComicLibraryError("INVALID_REFERENCE", 400);
          pushMedia(found, 1);
        }
      }
      const prompt = [
        target.kind === "slot" ? `Draw an original comic character design, ${label}.` : `Draw a comic facial expression close-up showing ${label}.`,
        ...(styleLabel ? [`Visual style: ${styleLabel}.`] : []),
        `Character: ${role.name}. Age: ${role.age}. Appearance: ${role.appearance}. Personality: ${role.personality}.`,
        ...(outfit ? [`Outfit: ${outfit.name}.`] : []),
        ...(references.length ? ["Use the supplied references for identity and visual style."] : []),
        "Use a plain background. Do not include text or watermarks.",
      ].join("\n");
      const input: ComicImageTakeInput = { schemaVersion: 1, promptVersion: 1, characterId: scope.id, target,
        aspectRatio: "1:1", modelId: price?.modelId ?? "unpriced", references, prompt };
      return { stamp, input };
    });
    return repo.quote(owner, scope, stamp, price, [input], []);
  }

  app.post("/series/:id/director/generation-preview", limit, async c => {
    const owner = c.get("userId"), id = pathId(c.req.param("id"));
    const body = comicGenerationPreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    media.assertAvailable();
    const quote = await previewSeries(owner, { kind: "series", id }, body.data);
    await director.recordQuote(owner, id, quote);
    return c.json(quote);
  });
  for (const resource of ["series", "characters"] as const) {
    const kind = resource === "series" ? "series" : "character";
    app.post(`/${resource}/:id/generation-preview`, limit, async c => {
      const owner = c.get("userId");
      const scope: ComicGenerationScope = { kind, id: pathId(c.req.param("id")) };
      const raw: unknown = await c.req.json().catch(() => null);
      media.assertAvailable();
      if (kind === "series") {
        const body = comicGenerationPreviewSchema.safeParse(raw);
        return body.success ? c.json(await previewSeries(owner, scope, body.data)) : c.json({ code: "INVALID_INPUT" }, 400);
      }
      const body = comicCharacterGenerateSchema.safeParse(raw);
      return body.success ? c.json(await previewCharacter(owner, scope, body.data)) : c.json({ code: "INVALID_INPUT" }, 400);
    });
    app.post(`/${resource}/:id/generate`, limit, async c => {
      const owner = c.get("userId");
      const body = comicGenerationConfirmSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
      const { confirmationId } = body.data;
      const { taskId, type, created } = await repo.confirm(owner, { kind, id: pathId(c.req.param("id")) }, confirmationId, async (model, mediaKind) => {
        deps.accepting?.();
        media.assertAvailable();
        return mediaKind === "video" ? await deps.quoteVideoPrice?.(owner, model) ?? null : quotePrice(owner, model);
      });
      if (created) await queue.publishNewTask(taskId, type).catch(() => {
        console.warn("[comic-drama] generation pending delivery", { taskId });
      });
      return c.json(await repo.status(owner, confirmationId), 202);
    });
  }

  app.get("/generation-requests/:id", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await repo.status(c.get("userId"), pathId(c.req.param("id"))));
  });
  app.post("/generation-requests/:id/recover", limit, async c => {
    const owner = c.get("userId");
    const id = pathId(c.req.param("id"));
    const { taskId, kind } = await repo.status(owner, id);
    media.assertAvailable();
    if (kind !== "image" || !await queue.canResumePersisted(taskId) || !await repo.prepareResume(owner, id, taskId)) {
      throw new ComicLibraryError("RECOVERY_UNAVAILABLE", 409);
    }
    await queue.resumePersisted(taskId, COMIC_IMAGE_TASK).catch(() => {
      console.warn("[comic-drama] recovery pending delivery", { taskId });
    });
    return c.json(await repo.status(owner, id), 202);
  });
  app.get("/series/:id/clips/:clipId/keyframes", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await repo.history(c.get("userId"), pathId(c.req.param("id")), pathId(c.req.param("clipId"))));
  });
  app.post("/series/:id/clips/:clipId/keyframe/confirm", limit, async c => {
    const body = comicKeyframeReviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.approve(c.get("userId"), pathId(c.req.param("id")), pathId(c.req.param("clipId")), body.data.keyframeTakeId,
      body.data.expectedClipRevision);
    return c.json({ ok: true });
  });
  app.post("/series/:id/clips/:clipId/keyframe/select", limit, async c => {
    const body = comicKeyframeSelectSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    await repo.selectKeyframeMedia(c.get("userId"), pathId(c.req.param("id")), pathId(c.req.param("clipId")), body.data.mediaId,
      body.data.expectedClipRevision);
    return c.json({ ok: true });
  });
  app.post("/series/:id/clips/:clipId/keyframe/upload", async c => {
    const rev = comicDramaRevisionSchema.safeParse({ expectedRevision: Number(c.req.query("expectedClipRevision")) });
    if (!rev.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId"), sid = pathId(c.req.param("id")), clipId = pathId(c.req.param("clipId"));
    return c.json(await media.upload(c.req.raw, owner, "scene", file =>
      repo.uploadKeyframeMedia(owner, sid, clipId, rev.data.expectedRevision, file)), 201);
  });
  app.get("/characters/:id/generations", async c => c.json(await repo.characterHistory(c.get("userId"), pathId(c.req.param("id")))));
  app.post("/image-takes/:id/cancel", limit, async c => {
    const owner = c.get("userId");
    const take = await repo.imageTake(owner, pathId(c.req.param("id")));
    await repo.cancelImageTake(owner, take.id, take.taskId);
    const { taskId: _taskId, slot: _slot, ...updated } = await repo.imageTake(owner, take.id);
    return c.json(updated);
  });
  app.post("/image-takes/:id/release", limit, async c => {
    const body = comicTakeReleaseSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId");
    const take = await repo.imageTake(owner, pathId(c.req.param("id")));
    await repo.releaseImageTake(owner, take.id, take.taskId);
    const { taskId: _taskId, slot: _slot, ...updated } = await repo.imageTake(owner, take.id);
    return c.json(updated);
  });
  app.route("/", createComicVideoRoutes({ repo: video, media, queue, library }));
  return app;
}
