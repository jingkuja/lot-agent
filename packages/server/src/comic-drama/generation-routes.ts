import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { PgComicDirector } from "./director-repository.js";
import { bodyLimit } from "hono/body-limit";
import type { Pool } from "pg";
import { MAX_IMAGE_EDIT_REFERENCES } from "@lot-agent/core";
import {
  buildComicGenerationInput, comicCharacterGenerateSchema, comicDramaIdSchema, comicDramaRevisionSchema,
  comicGenerationConfirmSchema, comicMaterialGenerateSchema, comicNewMaterialGenerateSchema,
  comicEpisodeBudgetSchema, comicGenerationPreviewSchema, comicKeyframeReviewSchema, comicKeyframeSelectSchema, comicTakeReleaseSchema,
  comicVideoProfile, validateComicVideoInput,
  type ComicCharacterGenerateRequest, type ComicCharacterUpload, type ComicDramaDetail, type ComicGenerationPreviewRequest, type ComicGenerationImage,
  type ComicFrozenGenerationInput, type ComicGenerationIssue, type ComicGenerationTimedMedia, type ComicMaterialGenerateRequest,
  type ComicGenerationQuote, type ComicGenerationReference, type ComicImageTakeInput, type ComicSkippedInvalidReference, type ComicTakeInput,
  type ComicNewMaterialGenerateRequest,
} from "@lot-agent/core/comic-drama";
import { COMIC_IMAGE_TASK } from "../jobs/task-queues.js";
import { assertComicDramaCompliance } from "./compliance.js";
import { createComicBudgetPredictionCache, estimateComicEpisode, type EpisodeBudgetPricing } from "./episode-budget.js";
import { readComicDictionary } from "./dictionary.js";
import { type ComicGenerationScope, type ComicPrice, type FrozenVisualReference, PgComicGeneration } from "./generation-repository.js";
import { ComicLibraryError, ComicSelectionConflictError, libraryMissing, libraryTransaction } from "./library-db.js";
import type { PgComicLibrary } from "./library-repository.js";
import type { ComicMediaLibrary, MeasuredComicReference } from "./media-library.js";
import { ComicDramaError, type PgComicDramaRepository } from "./repository.js";
import { PgComicSettings } from "./settings-repository.js";
import { PgComicVideo, visualReferenceKey } from "./video-repository.js";
import { createComicVideoRoutes } from "./video-routes.js";

export type GenerationQueue = {
  publishNewTask(id: string, type: string): Promise<void>;
  canResumePersisted(id: string): Promise<boolean>;
  resumePersisted(id: string, type: string): Promise<void>;
};
export type ComicSeriesPreviewDeps = {
  pool: Pool;
  series: Pick<PgComicDramaRepository, "get">;
  media: Pick<ComicMediaLibrary, "assertAvailable" | "assertVideoReferenceOrigin" | "inspectVideoReference">;
  quotePrice: (owner: string, model?: string) => Promise<ComicPrice | null>;
  quoteVideoPrice?: (owner: string, model: string) => Promise<ComicPrice | null>;
  repo?: Pick<PgComicGeneration, "quote">;
  video?: Pick<PgComicVideo, "frames" | "inspectReferences" | "generationReferences">;
  settings?: Pick<PgComicSettings, "getStylePreset">;
  readStyleDictionary?: (owner: string) => ReturnType<typeof readComicDictionary>;
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
  budgetPricing?: (owner: string, includeText: boolean, signal: AbortSignal) => Promise<EpisodeBudgetPricing>;
};

function createReferenceMeasurements(media: ComicSeriesPreviewDeps["media"], owner: string, signal: AbortSignal) {
  const seen = new Map<string, Promise<MeasuredComicReference | null>>();
  const active = new Set<Promise<unknown>>();
  return (mediaId: string) => {
    const previous = seen.get(mediaId);
    if (previous) return previous;
    const measured = (async () => {
      while (active.size >= 4) await Promise.race(active);
      signal.throwIfAborted();
      const probe = media.inspectVideoReference(owner, mediaId, signal);
      const settled = probe.catch(() => {});
      active.add(settled);
      try { return await probe; } finally { active.delete(settled); }
    })();
    seen.set(mediaId, measured);
    return measured;
  };
}

type Measure = ReturnType<typeof createReferenceMeasurements>;
type FrozenReference = ComicGenerationImage | ComicGenerationTimedMedia;

function referenceUnverified(ref: { mediaId: string; label?: string }): ComicGenerationIssue {
  return { code: "REFERENCE_UNVERIFIED", mediaId: ref.mediaId, label: ref.label };
}

async function measureFrozenReference(measure: Measure, ref: FrozenReference) {
  const actual = await measure(ref.mediaId);
  if (!actual || actual.mime !== ref.mime || actual.sizeBytes !== ref.sizeBytes) return false;
  if (actual.kind === "image") return "width" in ref && actual.width === ref.width && actual.height === ref.height;
  if (!("durationMs" in ref) || actual.durationMs !== ref.durationMs || actual.audioCodec !== ref.audioCodec) return false;
  if (actual.kind === "audio") return ref.kind === "audio" && actual.sampleRate === ref.sampleRate && actual.channels === ref.channels;
  return ref.kind === "video" && actual.width === ref.width && actual.height === ref.height && actual.fps === ref.fps
    && actual.videoCodec === ref.videoCodec;
}

function videoReferences(input: ComicFrozenGenerationInput) {
  return [...input.references, ...(input.firstFrame ? [input.firstFrame] : []),
    ...(input.lastFrame ? [input.lastFrame] : []), ...(input.timedReferences ?? [])];
}

function createSeriesInputResolver(deps: ComicSeriesPreviewDeps) {
  const video = deps.video ?? new PgComicVideo(deps.pool);
  const settings = deps.settings ?? new PgComicSettings(deps.pool);
  const readStyles = deps.readStyleDictionary ?? ((owner: string) => readComicDictionary(deps.pool, owner, "style"));

  return async (
    owner: string, detail: ComicDramaDetail, body: ComicGenerationPreviewRequest, modelId: Promise<string>, signal: AbortSignal,
    forecastFirstFrame = false,
  ) => {
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
    const strictFirstFrame = body.mode === "from_keyframe";
    const explicitRefs = body.visualReferences ?? [];
    if (strictFirstFrame && explicitRefs.length) {
      return { inputs: [], skipped: clips.map(clip => ({ clipId: clip.id, reason: "REFERENCE_MODE_CONFLICT" as const })),
        replaceAdopted: [], visualReferences: [] };
    }
    const persistedSpecs = strictFirstFrame ? [] : clips.flatMap(clip => [
      ...(clip.draft.sceneRef ? [{ kind: "scene" as const, ...clip.draft.sceneRef, pinned: true as const }] : []),
      ...(clip.draft.propRefs ?? []).map(ref => ({ kind: "prop" as const, ...ref, pinned: true as const })),
    ]);
    const uniquePersisted = [...new Map([...explicitRefs, ...persistedSpecs].map(ref => [visualReferenceKey(ref), ref])).values()];
    const specs = isVideo ? clips.flatMap(clip => clip.draft.videoInputs?.references ?? []) : [];
    const measure = createReferenceMeasurements(deps.media, owner, signal);
    const [model, styles, frames, persistedInspection, stylePreset, generationRefs] = await Promise.all([
      modelId,
      readStyles(owner),
      isVideo ? video.frames(owner, detail.series.id, clips.map(clip => clip.id)) : null,
      video.inspectReferences(owner, uniquePersisted),
      strictFirstFrame || explicitRefs.some(ref => ref.kind === "style") ? null : settings.getStylePreset(owner, detail.series.styleKey),
      specs.length ? video.generationReferences(owner, specs) : [],
    ]);
    const generationsById = new Map(generationRefs.map(ref => [ref.materialId, ref]));
    const styleDescription = styles.find(entry => entry.key === detail.series.styleKey)?.labels.en;
    const styleRef: (ComicGenerationReference & { kind: "style" }) | null = stylePreset
      && (stylePreset.media.mime === "image/jpeg" || stylePreset.media.mime === "image/png" || stylePreset.media.mime === "image/webp")
      && stylePreset.media.width && stylePreset.media.height
      ? {
        mediaId: stylePreset.media.id, version: 1, mime: stylePreset.media.mime, sizeBytes: stylePreset.media.sizeBytes,
        width: stylePreset.media.width, height: stylePreset.media.height, kind: "style", label: styleDescription ?? detail.series.styleKey,
      } : null;
    const inputs: ComicTakeInput[] = [];
    const skipped: ComicGenerationQuote["skipped"] = [];
    const replaceAdopted = body.targets.filter(target => target.replaceAdopted).map(target => target.clipId);
    const frozenVisualMap = new Map<string, FrozenVisualReference>();
    for (const clip of clips) {
      const versions = frames?.get(clip.id);
      if (versions?.adopted && !replaceAdopted.includes(clip.id)) { skipped.push({ clipId: clip.id, reason: "ALREADY_COMPLETE" }); continue; }
      const clipRefs: ComicGenerationReference[] = [];
      const seenMedia = new Set<string>();
      const clipPersisted = strictFirstFrame ? [] : [
        ...explicitRefs.map(({ kind, ...ref }) => ({ role: kind, ...ref, name: undefined, pinned: undefined })),
        ...(clip.draft.sceneRef ? [{ role: "scene" as const, ...clip.draft.sceneRef, pinned: true as const }] : []),
        ...(clip.draft.propRefs ?? []).map(ref => ({ role: "prop" as const, ...ref, pinned: true as const })),
      ];
      const invalidReferences: ComicSkippedInvalidReference[] = [];
      const clipFrozen: FrozenVisualReference[] = [];
      for (const ref of clipPersisted) {
        const key = visualReferenceKey({ kind: ref.role, materialId: ref.materialId, mediaId: ref.mediaId, pinned: ref.pinned });
        const invalidReason = persistedInspection.invalid.get(key);
        if (invalidReason) {
          invalidReferences.push({
            role: ref.role, materialId: ref.materialId, mediaId: ref.mediaId, ...(ref.name ? { name: ref.name } : {}), reason: invalidReason,
          });
          continue;
        }
        const resolved = persistedInspection.resolved.get(key);
        if (!resolved) {
          invalidReferences.push({
            role: ref.role, materialId: ref.materialId, mediaId: ref.mediaId, ...(ref.name ? { name: ref.name } : {}), reason: "MISSING",
          });
          continue;
        }
        if (seenMedia.has(resolved.mediaId)) continue;
        seenMedia.add(resolved.mediaId);
        clipRefs.push(resolved);
        clipFrozen.push({ materialId: resolved.materialId, mediaId: resolved.mediaId, version: resolved.version, pinned: ref.pinned });
      }
      if (invalidReferences.length) {
        skipped.push({ clipId: clip.id, reason: "INVALID_MATERIAL_REFERENCE", invalidReferences });
        continue;
      }
      const refIssues: ComicGenerationIssue[] = [];
      const timedReferences: ComicGenerationTimedMedia[] = [];
      let lastFrame: ComicGenerationImage | undefined;
      const manual = isVideo ? clip.draft.videoInputs?.references ?? [] : [];
      if (manual.some(ref => strictFirstFrame !== (ref.kind === "last_frame"))) {
        skipped.push({ clipId: clip.id, reason: "REFERENCE_MODE_CONFLICT" });
        continue;
      }
      const measured = await Promise.all(manual.map(async spec => {
        const ref = generationsById.get(spec.materialId);
        if (!ref || ref.mediaId !== spec.mediaId || !ref.mime.startsWith((spec.kind === "last_frame" ? "image" : spec.kind) + "/")) return { spec };
        return { spec, ref, actual: await measure(ref.mediaId) };
      }));
      for (const { spec, ref, actual } of measured) {
        if (!ref) {
          refIssues.push({ code: "INVALID_GENERATION_REFERENCE", mediaId: spec.mediaId, label: spec.name });
          continue;
        }
        if (!actual || actual.mime !== ref.mime) { refIssues.push(referenceUnverified(ref)); continue; }
        const base = { mediaId: ref.mediaId, version: ref.version };
        if (actual.kind === "image") {
          const { kind: _, ...image } = actual;
          if (spec.kind === "last_frame") lastFrame = { ...base, ...image };
          else if (!seenMedia.has(ref.mediaId)) clipRefs.push({ ...base, ...image, kind: "image", label: ref.label });
          seenMedia.add(ref.mediaId);
        } else timedReferences.push({ ...base, ...actual, label: ref.label });
        clipFrozen.push({ materialId: ref.materialId, ...base });
      }
      if (refIssues.length) {
        skipped.push({ clipId: clip.id, reason: refIssues[0].code, issues: refIssues });
        continue;
      }
      if (styleRef && stylePreset && !seenMedia.has(styleRef.mediaId)) {
        clipRefs.push(styleRef);
        clipFrozen.push({ materialId: null, mediaId: styleRef.mediaId, version: 1, styleKey: stylePreset.styleKey });
      }
      const built = buildComicGenerationInput({ series: detail.series, clip, cast: detail.cast,
        modelId: model,
        styleDescription, mode: body.mode, firstFrame: versions?.frame ?? undefined, visualReferences: clipRefs, lastFrame, timedReferences,
        forecastFirstFrame });
      if (!built.ok) {
        const reason = built.issues[0].code;
        const profile = comicVideoProfile(model);
        const referenceLimit = built.issues[0].field === "images" ? profile?.referenceImages.total : undefined;
        const durationLimit = reason === "DURATION_UNSUPPORTED" ? profile?.shotMaxSeconds : undefined;
        skipped.push({ clipId: clip.id, reason, ...(isVideo ? { issues: built.issues } : {}),
          ...(referenceLimit ? { referenceLimit } : {}), ...(durationLimit ? { durationLimit } : {}) });
      } else if (!isVideo && built.input.references.length > MAX_IMAGE_EDIT_REFERENCES) {
        skipped.push({ clipId: clip.id, reason: "REFERENCE_LIMIT", referenceLimit: MAX_IMAGE_EDIT_REFERENCES });
      }
      else if (!isVideo && built.input.prompt.length > 24_000) skipped.push({ clipId: clip.id, reason: "PROMPT_TOO_LONG" });
      else {
        if (isVideo) {
          const invalid = (await Promise.all(videoReferences(built.input).map(async ref => await measureFrozenReference(measure, ref)
            ? null : referenceUnverified(ref)))).filter(issue => issue !== null);
          if (invalid.length) { skipped.push({ clipId: clip.id, reason: "REFERENCE_UNVERIFIED", issues: invalid }); continue; }
        }
        for (const frozenRef of clipFrozen) {
          frozenVisualMap.set(`${frozenRef.styleKey ?? frozenRef.materialId}:${frozenRef.mediaId}:${!!frozenRef.pinned}`, frozenRef);
        }
        inputs.push(built.input);
      }
    }
    return { inputs, skipped, replaceAdopted, visualReferences: [...frozenVisualMap.values()] };
  };
}

export function createComicSeriesPreviewer(deps: ComicSeriesPreviewDeps) {
  const repo = deps.repo ?? new PgComicGeneration(deps.pool);
  const resolve = createSeriesInputResolver(deps);
  return async (
    owner: string, scope: ComicGenerationScope, body: ComicGenerationPreviewRequest, signal: AbortSignal = new AbortController().signal,
  ): Promise<ComicGenerationQuote> => {
    const detail = await deps.series.get(owner, scope.id);
    if (detail.series.archivedAt) libraryMissing();
    const isVideo = body.mode !== "keyframe";
    const videoModel = detail.series.videoModel;
    const getPrice = isVideo ? videoModel && deps.quoteVideoPrice ? deps.quoteVideoPrice(owner, videoModel) : Promise.resolve(null) : deps.quotePrice(owner);
    const [price, { inputs, skipped, replaceAdopted, visualReferences }] = await Promise.all([
      getPrice, resolve(owner, detail, body, getPrice.then(price => isVideo ? videoModel ?? "" : price?.modelId ?? "unpriced"), signal),
    ]);
    if (price && isVideo && inputs.some(input => "clipId" in input && videoReferences(input).length)) {
      deps.media.assertVideoReferenceOrigin();
    }
    return repo.quote(owner, scope, String(detail.series.revision), price, inputs, skipped, replaceAdopted, visualReferences);
  };
}

export function createComicGenerationRoutes(deps: Dependencies) {
  const { pool, library, series, media, quotePrice, queue } = deps;
  const repo = new PgComicGeneration(pool);
  const video = new PgComicVideo(pool);
  const settings = new PgComicSettings(pool);
  const director = new PgComicDirector(pool, series);
  const previewSeries = createComicSeriesPreviewer({ ...deps, repo, video, settings });
  const resolveSeriesInputs = createSeriesInputResolver({ ...deps, video, settings });
  const app = new Hono<{ Variables: { userId: string } }>();
  const limit = bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) });
  app.onError((error, c) => {
    if (error instanceof ComicSelectionConflictError) {
      return c.json({ code: error.code, currentSelectionRevision: error.currentSelectionRevision }, 409);
    }
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
  if (deps.budgetPricing) {
    const budgetPricing = deps.budgetPricing;
    const cachedPricing = createComicBudgetPredictionCache();
    app.post("/series/:id/episode-budget", limit, async c => {
      const body = comicEpisodeBudgetSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
      const owner = c.get("userId");
      const detail = await series.get(owner, pathId(c.req.param("id")));
      if (detail.series.revision !== body.data.expectedRevision) throw new ComicLibraryError("QUOTE_STALE", 409);
      const signal = c.req.raw.signal;
      const pricing = cachedPricing(owner, detail.series.id, await budgetPricing(owner, !!body.data.text, signal));
      c.header("Cache-Control", "private, no-store");
      return c.json(await estimateComicEpisode(detail, body.data, pricing,
        (preview, model, forecastFirstFrame) => resolveSeriesInputs(owner, detail, preview, Promise.resolve(model), signal, forecastFirstFrame), signal));
    });
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
      if (stylePreset) pushMedia(stylePreset.media, 1);
      if (req.referenceMediaIds?.length) {
        const { rows: extraMedia } = await db.query<{ id: string; mime: string; sizeBytes: number; width: number | null; height: number | null }>(
          `SELECT id, mime, size_bytes AS "sizeBytes", width, height FROM lot_comic_drama.cd_media WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
          [owner, req.referenceMediaIds],
        );
        for (const extraId of req.referenceMediaIds) {
          const found = extraMedia.find(item => item.id === extraId);
          if (!found?.mime.startsWith("image/") || !found.width || !found.height) throw new ComicLibraryError("INVALID_REFERENCE", 400);
          pushMedia(found, role.assets.find(asset => asset.media.id === extraId)?.version ?? 1);
        }
      }
      if (asset) pushMedia(asset.media, asset.version);
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

  async function previewMaterial(owner: string, req: ComicMaterialGenerateRequest | ComicNewMaterialGenerateRequest) {
    const existing = "materialId" in req;
    const scope: ComicGenerationScope = { kind: "material", id: existing ? req.materialId : randomUUID() };
    const { material, stamp } = existing ? await libraryTransaction(pool, async db => ({
      stamp: await repo.materialStamp(db, owner, scope.id), material: await library.materialInput(owner, scope.id, db),
    })) : { material: { name: req.name, kind: req.kind, tags: [] }, stamp: "" };
    if (material.kind !== req.kind) throw new ComicLibraryError("INVALID_INPUT", 400);
    const [price, stylePreset, styles, mediaItems] = await Promise.all([
      quotePrice(owner), req.styleKey ? settings.getStylePreset(owner, req.styleKey) : null,
      req.styleKey ? readComicDictionary(pool, owner, "style") : [],
      Promise.all([...new Set(req.referenceMediaIds)].map(mediaId => library.materialImageReference(owner, mediaId))),
    ]);
    const style = req.styleKey && styles.find(item => item.key === req.styleKey);
    if (req.styleKey && !style) throw new ComicLibraryError("INVALID_REFERENCE", 400);
    const unique = new Map<string, ComicGenerationImage>();
    for (const item of [...(stylePreset ? [{ ...stylePreset.media, version: 1 }] : []), ...mediaItems]) {
      if (!item?.width || !item.height || (item.mime !== "image/jpeg" && item.mime !== "image/png" && item.mime !== "image/webp")) {
        throw new ComicLibraryError("INVALID_REFERENCE", 400);
      }
      unique.set(item.id, { mediaId: item.id, mime: item.mime, sizeBytes: item.sizeBytes, width: item.width, height: item.height, version: item.version });
    }
    const references = [...unique.values()];
    const prompt = [
      `Create an original comic ${req.kind} image named ${material.name}.`,
      material.tags.length ? `Tags: ${material.tags.join(", ")}.` : "",
      style ? `Visual style: ${style.labels.en}.` : "",
      `Description: ${req.prompt}`,
      ...(stylePreset ? ["Follow the supplied style reference."] : []),
      ...(references.length ? ["Use the supplied references for composition and visual consistency."] : []),
      "Do not include text or watermarks.",
    ].filter(Boolean).join("\n");
    assertComicDramaCompliance([{ field: "material.prompt", text: prompt }]);
    return repo.quote(owner, scope, stamp, price, [{ schemaVersion: 1, promptVersion: 1, materialId: scope.id,
      target: { kind: "material", materialId: scope.id }, modelId: price?.modelId ?? "unpriced", aspectRatio: "1:1", references, prompt }],
    [], undefined, undefined, undefined, existing ? undefined : { name: material.name, kind: req.kind });
  }

  app.post("/materials/generation-preview", limit, async c => {
    const body = comicNewMaterialGenerateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    media.assertAvailable();
    return c.json(await previewMaterial(c.get("userId"), body.data));
  });
  app.get("/material-generations", async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json(await repo.materialHistory(c.get("userId")));
  });

  app.post("/series/:id/director/generation-preview", limit, async c => {
    const owner = c.get("userId"), id = pathId(c.req.param("id"));
    const body = comicGenerationPreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    media.assertAvailable();
    const quote = await previewSeries(owner, { kind: "series", id }, body.data, c.req.raw.signal);
    await director.recordQuote(owner, id, quote);
    return c.json(quote);
  });
  for (const resource of ["series", "characters", "materials"] as const) {
    const kind = resource === "series" ? "series" : resource === "characters" ? "character" : "material";
    app.post(`/${resource}/:id/generation-preview`, limit, async c => {
      const owner = c.get("userId");
      const scope: ComicGenerationScope = { kind, id: pathId(c.req.param("id")) };
      const raw: unknown = await c.req.json().catch(() => null);
      media.assertAvailable();
      if (kind === "series") {
        const body = comicGenerationPreviewSchema.safeParse(raw);
        return body.success ? c.json(await previewSeries(owner, scope, body.data, c.req.raw.signal)) : c.json({ code: "INVALID_INPUT" }, 400);
      }
      if (kind === "character") {
        const body = comicCharacterGenerateSchema.safeParse(raw);
        return body.success ? c.json(await previewCharacter(owner, scope, body.data)) : c.json({ code: "INVALID_INPUT" }, 400);
      }
      const body = comicMaterialGenerateSchema.safeParse(raw);
      return body.success && body.data.materialId === scope.id
        ? c.json(await previewMaterial(owner, body.data)) : c.json({ code: "INVALID_INPUT" }, 400);
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
      }, async inputs => {
        const refs = inputs.flatMap(videoReferences);
        if (refs.length) media.assertVideoReferenceOrigin();
        const measure = createReferenceMeasurements(media, owner, c.req.raw.signal);
        const verified = await Promise.all(refs.map(ref => measureFrozenReference(measure, ref)));
        if (verified.some(value => !value) || inputs.some(input => validateComicVideoInput(input).length)) {
          throw new ComicLibraryError("QUOTE_STALE", 409);
        }
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
    const updated = await repo.approve(c.get("userId"), pathId(c.req.param("id")), pathId(c.req.param("clipId")),
      body.data.keyframeTakeId, body.data.expectedClipRevision, body.data.expectedSelectionRevision);
    return c.json({ ok: true, selectionRevision: updated.selectionRevision });
  });
  app.post("/series/:id/clips/:clipId/keyframe/select", limit, async c => {
    const body = comicKeyframeSelectSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const updated = await repo.selectKeyframeMedia(c.get("userId"), pathId(c.req.param("id")), pathId(c.req.param("clipId")),
      body.data.mediaId, body.data.expectedClipRevision, body.data.expectedSelectionRevision);
    return c.json({ ok: true, selectionRevision: updated.selectionRevision });
  });
  app.post("/series/:id/clips/:clipId/keyframe/upload", async c => {
    const rev = comicDramaRevisionSchema.safeParse({ expectedRevision: Number(c.req.query("expectedClipRevision")) });
    const sel = comicDramaRevisionSchema.safeParse({ expectedRevision: Number(c.req.query("expectedSelectionRevision")) });
    if (!rev.success || !sel.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const owner = c.get("userId"), sid = pathId(c.req.param("id")), clipId = pathId(c.req.param("clipId"));
    return c.json(await media.upload(c.req.raw, owner, "scene", file =>
      repo.uploadKeyframeMedia(owner, sid, clipId, rev.data.expectedRevision, sel.data.expectedRevision, file)), 201);
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
  app.route("/", createComicVideoRoutes({ repo: video, media, queue, library, accepting: deps.accepting }));
  return app;
}
