import {
  comicVideoDurationSupported, comicVideoModel, comicVideoProfile, mapComicVideoResolution,
  type ComicVideoProfile, type ComicVideoResolution,
} from "./models.js";
import type { ComicSeriesCast } from "./cast.js";
import { resolveComicReferenceCast } from "./checks.js";
import type { ComicClipModelAdaptation, ComicDramaClip, ComicDramaClipDraft } from "./index.js";

export type ComicModelAdaptationAction =
  | { kind: "map_resolution"; from: ComicVideoResolution; to: ComicVideoResolution }
  | { kind: "restore_resolution"; from: ComicVideoResolution | undefined; to: ComicVideoResolution }
  | { kind: "fold_images"; foldedCount: number; keptCount: number; limit: number }
  | { kind: "unfold_images"; restoredCount: number }
  | { kind: "disable_source_duration" }
  | { kind: "restore_source_duration" }
  | { kind: "clamp_duration"; fromMs: number; toMs: number };

export type ComicModelSwitchIssue =
  | { code: "DURATION_EXCEEDS_MAX"; durationMs: number; maxSeconds: number }
  | { code: "DURATION_OUT_OF_RANGE"; durationMs: number; minSeconds: number; maxSeconds: number }
  | { code: "RESOLUTION_UNSUPPORTED"; from: ComicVideoResolution; to: ComicVideoResolution }
  | { code: "IMAGE_LIMIT_EXCEEDED"; totalImages: number; limit: number; excess: number }
  | { code: "FILE_LIMIT_EXCEEDED"; totalFiles: number; limit: number; excess: number }
  | { code: "AUDIO_COUNT_EXCEEDED"; count: number; limit: number }
  | { code: "VIDEO_COUNT_EXCEEDED"; count: number; limit: number }
  | { code: "AUDIO_ONLY_UNSUPPORTED"; audioCount: number }
  | { code: "EXTEND_UNSUPPORTED" };

export type ComicModelSwitchClipReport = {
  clipId: string;
  clipOrdinal: number;
  scene: string;
  issues: ComicModelSwitchIssue[];
  actions: ComicModelAdaptationAction[];
  canAutoAdapt: boolean;
  canRestore: boolean;
  durationNeedsAttention: boolean;
  adaptedDraft: ComicDramaClipDraft;
};

export type ComicModelSwitchReport = {
  targetModelId: string;
  targetLabel: string;
  targetProfile: ComicVideoProfile;
  affectedClips: ComicModelSwitchClipReport[];
  totalIssueCount: number;
  autoAdaptableCount: number;
  restorableCount: number;
  durationNeedsAttentionCount: number;
};

type ImagePrioritySlot =
  | { group: "cast_slot"; characterId: string }
  | { group: "cast_expression"; characterId: string }
  | { group: "scene" }
  | { group: "style" }
  | { group: "prop"; mediaId: string }
  | { group: "extra_image"; mediaId: string };

/** Ordered highest-to-lowest priority: cast (slot -> expression) > scene > style > prop > extra image. */
function prioritizedImageSlots(draft: ComicDramaClipDraft, hasStyleRef: boolean, cast?: readonly ComicSeriesCast[]): ImagePrioritySlot[] {
  const slots: ImagePrioritySlot[] = [];
  const actors = cast ? resolveComicReferenceCast(draft, cast) : draft.cast ?? [];
  for (const actor of actors) {
    if (actor.slotKey) slots.push({ group: "cast_slot", characterId: actor.characterId });
  }
  for (const actor of actors) {
    if (actor.expressionKey) slots.push({ group: "cast_expression", characterId: actor.characterId });
  }
  if (draft.sceneRef) slots.push({ group: "scene" });
  if (hasStyleRef) slots.push({ group: "style" });
  for (const prop of draft.propRefs ?? []) {
    slots.push({ group: "prop", mediaId: prop.mediaId });
  }
  for (const ref of draft.videoInputs?.references ?? []) {
    if (ref.kind === "image") slots.push({ group: "extra_image", mediaId: ref.mediaId });
  }
  return slots;
}

function countFoldedInAdaptation(adaptation: ComicClipModelAdaptation | undefined): number {
  if (!adaptation) return 0;
  return (adaptation.foldedCastRefs?.length ?? 0)
    + (adaptation.foldedSceneRef ? 1 : 0)
    + (adaptation.foldedStyleRef ? 1 : 0)
    + (adaptation.foldedPropMediaIds?.length ?? 0)
    + (adaptation.foldedExtraImageMediaIds?.length ?? 0);
}

/**
 * Non-destructively adapts a clip draft for the target video model.
 * Original resolution, sourceDuration, and reference bindings stay preserved so switching back restores them.
 */
export function adaptComicClipDraftForModel(
  draft: ComicDramaClipDraft,
  targetModelId: string,
  opts?: { hasStyleRef?: boolean; clampDuration?: boolean; cast?: readonly ComicSeriesCast[] },
): { draft: ComicDramaClipDraft; changed: boolean; actions: ComicModelAdaptationAction[] } {
  const profile = comicVideoProfile(targetModelId);
  if (!profile) return { draft, changed: false, actions: [] };

  const hasStyleRef = !!opts?.hasStyleRef;
  const existing = draft.videoInputs;
  const prevAdaptation = existing?.modelAdaptation;
  const refs = existing?.references ?? [];
  const audioCount = refs.filter(ref => ref.kind === "audio").length;
  const videoCount = refs.filter(ref => ref.kind === "video").length;
  const actions: ComicModelAdaptationAction[] = [];

  // 1. Resolution: restore original if target supports it, else map nearest and preserve originalResolution.
  const baseResolution = prevAdaptation?.originalResolution ?? existing?.resolution;
  let nextResolution = existing?.resolution;
  let originalResolution = prevAdaptation?.originalResolution;
  if (baseResolution && profile.resolutions.includes(baseResolution)) {
    if (existing?.resolution !== baseResolution) {
      actions.push({ kind: "restore_resolution", from: existing?.resolution, to: baseResolution });
    }
    nextResolution = baseResolution;
    originalResolution = undefined;
  } else if (baseResolution) {
    const mapped = mapComicVideoResolution(baseResolution, profile) ?? profile.resolution;
    if (existing?.resolution !== mapped) {
      actions.push({ kind: "map_resolution", from: existing?.resolution ?? baseResolution, to: mapped });
    }
    nextResolution = mapped;
    originalResolution = baseResolution;
  }

  // 2. Extend / sourceDuration: restore when target supports extend; otherwise disable non-destructively.
  const baseSourceDuration = prevAdaptation?.originalSourceDuration ?? existing?.sourceDuration;
  let nextSourceDuration = existing?.sourceDuration;
  let originalSourceDuration = prevAdaptation?.originalSourceDuration;
  if (baseSourceDuration) {
    if (profile.operations.includes("extend")) {
      if (!existing?.sourceDuration) actions.push({ kind: "restore_source_duration" });
      nextSourceDuration = true;
      originalSourceDuration = undefined;
    } else {
      if (existing?.sourceDuration) actions.push({ kind: "disable_source_duration" });
      nextSourceDuration = undefined;
      originalSourceDuration = true;
    }
  }

  // 3. Reference image folding in priority order: cast > scene > style > prop > extra image.
  const allSlots = prioritizedImageSlots(draft, hasStyleRef, opts?.cast);
  const maxImagesByFiles = Math.max(0, profile.referenceMedia.totalFiles - audioCount - videoCount);
  const effectiveImageBudget = Math.min(profile.referenceImages.total, maxImagesByFiles);
  const foldedSlots = allSlots.slice(effectiveImageBudget);
  const prevFoldedCount = countFoldedInAdaptation(prevAdaptation);
  if (foldedSlots.length > 0 && foldedSlots.length !== prevFoldedCount) {
    actions.push({
      kind: "fold_images",
      foldedCount: foldedSlots.length,
      keptCount: allSlots.length - foldedSlots.length,
      limit: effectiveImageBudget,
    });
  } else if (foldedSlots.length === 0 && prevFoldedCount > 0) {
    actions.push({ kind: "unfold_images", restoredCount: prevFoldedCount });
  }

  const foldedCastRefs: NonNullable<ComicClipModelAdaptation["foldedCastRefs"]> = [];
  let foldedSceneRef: true | undefined;
  let foldedStyleRef: true | undefined;
  const foldedPropMediaIds: string[] = [];
  const foldedExtraImageMediaIds: string[] = [];
  for (const slot of foldedSlots) {
    if (slot.group === "cast_slot") foldedCastRefs.push({ characterId: slot.characterId, kind: "slot" });
    else if (slot.group === "cast_expression") foldedCastRefs.push({ characterId: slot.characterId, kind: "expression" });
    else if (slot.group === "scene") foldedSceneRef = true;
    else if (slot.group === "style") foldedStyleRef = true;
    else if (slot.group === "prop") foldedPropMediaIds.push(slot.mediaId);
    else foldedExtraImageMediaIds.push(slot.mediaId);
  }

  const hasAdaptationFields = Boolean(
    originalResolution || originalSourceDuration || foldedCastRefs.length
    || foldedSceneRef || foldedStyleRef || foldedPropMediaIds.length || foldedExtraImageMediaIds.length,
  );
  const nextAdaptation: ComicClipModelAdaptation | undefined = hasAdaptationFields ? {
    targetModelId,
    ...(originalResolution ? { originalResolution } : {}),
    ...(originalSourceDuration ? { originalSourceDuration } : {}),
    ...(foldedCastRefs.length ? { foldedCastRefs } : {}),
    ...(foldedSceneRef ? { foldedSceneRef } : {}),
    ...(foldedStyleRef ? { foldedStyleRef } : {}),
    ...(foldedPropMediaIds.length ? { foldedPropMediaIds } : {}),
    ...(foldedExtraImageMediaIds.length ? { foldedExtraImageMediaIds } : {}),
  } : undefined;

  // 4. Optional explicit duration clamp (never silent unless requested by user).
  let nextDurationMs = draft.durationMs;
  if (opts?.clampDuration && draft.durationMs > profile.shotMaxSeconds * 1000) {
    nextDurationMs = profile.shotMaxSeconds * 1000;
    actions.push({ kind: "clamp_duration", fromMs: draft.durationMs, toMs: nextDurationMs });
  }

  const hasVideoInputs = Boolean(
    refs.length || nextResolution || nextSourceDuration || existing?.audioMode || nextAdaptation,
  );
  const nextVideoInputs: ComicDramaClipDraft["videoInputs"] = hasVideoInputs ? {
    references: refs,
    ...(nextResolution ? { resolution: nextResolution } : {}),
    ...(nextSourceDuration ? { sourceDuration: nextSourceDuration } : {}),
    ...(existing?.audioMode ? { audioMode: existing.audioMode } : {}),
    ...(nextAdaptation ? { modelAdaptation: nextAdaptation } : {}),
  } : undefined;

  const nextDraft: ComicDramaClipDraft = {
    ...draft,
    durationMs: nextDurationMs,
    ...(nextVideoInputs ? { videoInputs: nextVideoInputs } : {}),
  };
  if (!nextVideoInputs) delete nextDraft.videoInputs;

  const changed = JSON.stringify(nextDraft) !== JSON.stringify(draft);
  return { draft: nextDraft, changed, actions };
}

/**
 * Inspects all clips in an episode against a target video model and reports incompatibilities,
 * restorable folded bindings, and a non-destructive adaptation preview per affected clip.
 */
export function analyzeComicModelSwitch(
  clips: readonly Pick<ComicDramaClip, "id" | "ordinal" | "draft">[],
  targetModelId: string | null | undefined,
  opts?: { hasStyleRef?: boolean; clampDuration?: boolean; cast?: readonly ComicSeriesCast[] },
): ComicModelSwitchReport | null {
  const model = comicVideoModel(targetModelId);
  const profile = comicVideoProfile(targetModelId ?? null);
  if (!targetModelId || !model || !profile) return null;

  const hasStyleRef = !!opts?.hasStyleRef;
  const affectedClips: ComicModelSwitchClipReport[] = [];
  let totalIssueCount = 0;
  let autoAdaptableCount = 0;
  let restorableCount = 0;
  let durationNeedsAttentionCount = 0;

  for (const clip of clips) {
    const { draft } = clip;
    const videoInputs = draft.videoInputs;
    const refs = videoInputs?.references ?? [];
    const audioCount = refs.filter(ref => ref.kind === "audio").length;
    const videoCount = refs.filter(ref => ref.kind === "video").length;
    const allImages = prioritizedImageSlots(draft, hasStyleRef, opts?.cast);
    const activeImagesCount = Math.max(0, allImages.length - countFoldedInAdaptation(videoInputs?.modelAdaptation));
    const totalFiles = activeImagesCount + audioCount + videoCount;
    const issues: ComicModelSwitchIssue[] = [];

    if (draft.durationMs > profile.shotMaxSeconds * 1000) {
      issues.push({ code: "DURATION_EXCEEDS_MAX", durationMs: draft.durationMs, maxSeconds: profile.shotMaxSeconds });
    } else if (!comicVideoDurationSupported(draft.durationMs, profile)) {
      issues.push({ code: "DURATION_OUT_OF_RANGE", durationMs: draft.durationMs, minSeconds: 4, maxSeconds: profile.shotMaxSeconds });
    }

    if (videoInputs?.resolution && !profile.resolutions.includes(videoInputs.resolution)) {
      const mapped = mapComicVideoResolution(videoInputs.resolution, profile) ?? profile.resolution;
      issues.push({ code: "RESOLUTION_UNSUPPORTED", from: videoInputs.resolution, to: mapped });
    }

    if (activeImagesCount > profile.referenceImages.total) {
      issues.push({
        code: "IMAGE_LIMIT_EXCEEDED",
        totalImages: activeImagesCount,
        limit: profile.referenceImages.total,
        excess: activeImagesCount - profile.referenceImages.total,
      });
    }

    if (totalFiles > profile.referenceMedia.totalFiles) {
      issues.push({
        code: "FILE_LIMIT_EXCEEDED",
        totalFiles,
        limit: profile.referenceMedia.totalFiles,
        excess: totalFiles - profile.referenceMedia.totalFiles,
      });
    }

    if (audioCount > profile.referenceMedia.count) {
      issues.push({ code: "AUDIO_COUNT_EXCEEDED", count: audioCount, limit: profile.referenceMedia.count });
    }
    if (videoCount > profile.referenceMedia.count) {
      issues.push({ code: "VIDEO_COUNT_EXCEEDED", count: videoCount, limit: profile.referenceMedia.count });
    }
    if (audioCount > 0 && !profile.referenceMedia.audioOnly && activeImagesCount === 0 && videoCount === 0) {
      issues.push({ code: "AUDIO_ONLY_UNSUPPORTED", audioCount });
    }
    if (videoInputs?.sourceDuration && !profile.operations.includes("extend")) {
      issues.push({ code: "EXTEND_UNSUPPORTED" });
    }

    const adapted = adaptComicClipDraftForModel(draft, targetModelId, opts);
    const canRestore = adapted.actions.some(
      action => action.kind === "restore_resolution" || action.kind === "unfold_images" || action.kind === "restore_source_duration",
    );
    const canAutoAdapt = adapted.changed;
    const durationNeedsAttention = draft.durationMs > profile.shotMaxSeconds * 1000;

    if (issues.length > 0 || canAutoAdapt) {
      totalIssueCount += issues.length;
      if (canAutoAdapt) autoAdaptableCount += 1;
      if (canRestore) restorableCount += 1;
      if (durationNeedsAttention) durationNeedsAttentionCount += 1;
      affectedClips.push({
        clipId: clip.id,
        clipOrdinal: clip.ordinal,
        scene: draft.scene,
        issues,
        actions: adapted.actions,
        canAutoAdapt,
        canRestore,
        durationNeedsAttention,
        adaptedDraft: adapted.draft,
      });
    }
  }

  return {
    targetModelId,
    targetLabel: model.label,
    targetProfile: profile,
    affectedClips,
    totalIssueCount,
    autoAdaptableCount,
    restorableCount,
    durationNeedsAttentionCount,
  };
}
