import { z } from "zod";
import { comicReferenceImageInvalid, comicVideoDurationSupported, comicVideoModel, comicVideoProfile } from "./models.js";
import { comicCastAsset, type ComicSeriesCast } from "./cast.js";
import { comicCharacterUpload, comicMaterialInput, comicSystemDictionary } from "./library.js";
import type { ComicCharacterUpload } from "./library.js";
import type { ComicDramaClip, ComicDramaSeries, ComicEpisodeCostSummary } from "./index.js";

const id = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const mode = z.enum(["keyframe", "from_keyframe", "references"]);
const targets = z.array(z.object({ clipId: id, expectedRevision: revision, replaceAdopted: z.boolean().optional() }).strict())
  .min(1).max(10).refine(items => new Set(items.map(item => item.clipId)).size === items.length);

export const comicGenerationPreviewSchema = z.object({
  expectedSeriesRevision: revision, mode, targets,
  visualReferences: z.array(z.object({ materialId: id, mediaId: id, kind: z.enum(["style", "scene", "prop"]) }).strict())
    .max(30).refine(items => new Set(items.map(item => item.mediaId)).size === items.length).optional(),
}).strict();
export const comicGenerationConfirmSchema = z.object({ confirmationId: id }).strict();
export type ComicGenerationPreviewRequest = z.infer<typeof comicGenerationPreviewSchema>;
export type ComicGenerationMode = z.infer<typeof mode>;
export type ComicQuoteLine = {
  clipId: string; modelId: string; unit: "image" | "second"; quantity: number;
  amountMicros: number | null;
  referenceVersions?: { mediaId: string; version: number }[];
};
export type ComicSkippedInvalidReference = {
  role: "scene" | "prop";
  materialId: string;
  mediaId: string;
  name?: string;
  reason: "MISSING" | "ARCHIVED" | "WRONG_KIND" | "OUTDATED_VERSION";
};
export type ComicGenerationQuote = {
  confirmationId: string | null;
  expiresAt: string | null;
  items: ComicQuoteLine[];
  skipped: {
    clipId: string;
    reason: ComicGenerationIssue["code"] | "BUSY" | "ALREADY_COMPLETE" | "PRICE_UNAVAILABLE" | "INVALID_MATERIAL_REFERENCE";
    referenceLimit?: number;
    durationLimit?: number;
    invalidReferences?: ComicSkippedInvalidReference[];
  }[];
  totalMicros: number | null;
  currency: "CNY" | "USD";
};

const image = z.object({
  mediaId: id, version: revision, mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
const reference = image.extend({
  kind: z.enum(["appearance", "expression", "style", "scene", "prop"]), label: z.string().min(1), characterId: id.optional(),
}).strict().refine(item => !!item.characterId === (item.kind === "appearance" || item.kind === "expression"));

export const comicFrozenGenerationSchema = z.object({
  schemaVersion: z.literal(1), promptVersion: z.literal(1), seriesId: id, seriesRevision: revision, clipId: id, clipRevision: revision,
  mode, modelId: z.string().min(1), aspectRatio: z.enum(["9:16", "16:9", "1:1"]), durationMs: z.number().int().min(1).max(60_000),
  styleKey: z.string().min(1), firstFrame: image.extend({ takeId: id.nullable() }).nullable(), references: z.array(reference), prompt: z.string().min(1),
  resolution: z.enum(["720p", "768P"]).optional(),
}).strict().refine(item => !!item.firstFrame === (item.mode === "from_keyframe"));

export type ComicGenerationImage = z.infer<typeof image>;
export type ComicGenerationReference = z.infer<typeof reference>;
export type ComicFrozenGenerationInput = z.infer<typeof comicFrozenGenerationSchema>;
export const comicImageTakeInput = z.union([
  comicFrozenGenerationSchema.refine(input => input.mode === "keyframe"),
  z.object({
    schemaVersion: z.literal(1), promptVersion: z.literal(1), characterId: id, target: comicCharacterUpload,
    modelId: z.string().min(1), aspectRatio: z.literal("1:1"), references: z.array(image), prompt: z.string().min(1),
  }).strict(),
]);
export type ComicImageTakeInput = z.infer<typeof comicImageTakeInput>;
export const comicKeyframeReviewSchema = z.object({
  keyframeTakeId: id,
  expectedClipRevision: revision,
  expectedSelectionRevision: revision,
}).strict();
export const comicKeyframeSelectSchema = z.object({
  mediaId: id,
  expectedClipRevision: revision,
  expectedSelectionRevision: revision,
}).strict();
const styleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const comicCharacterGenerateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("slot"), key: styleKeySchema, outfitId: id,
    styleKey: styleKeySchema.optional(),
    referenceMediaIds: z.array(id).max(4).optional(),
  }).strict(),
  z.object({
    kind: z.literal("expression"), key: styleKeySchema,
    styleKey: styleKeySchema.optional(),
    referenceMediaIds: z.array(id).max(4).optional(),
  }).strict(),
]);
export type ComicCharacterGenerateRequest = z.infer<typeof comicCharacterGenerateSchema>;
export const comicMaterialGenerateSchema = z.object({
  materialId: id, kind: z.enum(["scene", "prop"]), styleKey: styleKeySchema.optional(),
  prompt: z.string().trim().min(1).max(4000), referenceMediaIds: z.array(id).max(4).optional(),
}).strict();
export type ComicMaterialGenerateRequest = z.infer<typeof comicMaterialGenerateSchema>;
const comicMaterialTakeInput = z.object({
  schemaVersion: z.literal(1), promptVersion: z.literal(1), materialId: id,
  target: z.object({ kind: z.literal("material"), materialId: id }).strict(),
  modelId: z.string().min(1), aspectRatio: z.enum(["9:16", "16:9", "1:1"]), references: z.array(image), prompt: z.string().min(1),
}).strict();
export const comicVideoTakeInput = comicFrozenGenerationSchema.refine(input => input.mode !== "keyframe");
export const comicTakeInput = z.union([comicImageTakeInput, comicMaterialTakeInput, comicVideoTakeInput]);
export type ComicTakeInput = z.infer<typeof comicTakeInput>;
export const comicVideoAdoptSchema = z.object({
  takeId: id,
  expectedClipRevision: revision,
  expectedSelectionRevision: revision,
}).strict();
export const comicTakeReleaseSchema = z.object({ acknowledgePossibleCharge: z.literal(true) }).strict();
export const comicVideoCreditResumeSchema = z.object({ continueDespiteLowCredits: z.literal(true).optional() }).strict();
export type ComicVideoCreditCheck =
  | { reason: "insufficient"; availablePoints: number; requiredPoints: number }
  | { reason: "gateway-insufficient" }
  | { reason: "unavailable" };
export type ComicVideoCreditPause = { takeId: string; clipId: string; canResume: boolean; check: ComicVideoCreditCheck };
export const COMIC_VIDEO_RESOLUTION = "720p";
export const COMIC_IMAGE_SIZES = { "9:16": "864x1536", "16:9": "1536x864", "1:1": "1024x1024" } as const;
const plannedCount = z.number().int().min(0).max(60).optional();
export const comicEpisodeBudgetSchema = z.object({
  expectedRevision: revision,
  videoMode: z.enum(["from_keyframe", "references"]).default("from_keyframe"),
  redoVideos: z.array(id).max(60).optional(),
  characterImages: plannedCount, materialImages: plannedCount, speechLines: plannedCount,
  text: z.object({ inputTokens: z.number().int().min(0).max(1_000_000), outputTokens: z.number().int().min(0).max(100_000) }).strict().optional(),
}).strict();
export type ComicEpisodeBudgetInput = z.input<typeof comicEpisodeBudgetSchema>;
export type ComicEpisodeBudgetLine = {
  kind: "keyframe" | "video" | "character" | "material" | "text" | "speech";
  modelId: string | null; clipId?: string; quantity: number; inputTokens?: number; outputTokens?: number;
  estimatedPoints: number | null;
};
export type ComicEpisodeBudget = {
  revision: number; items: ComicEpisodeBudgetLine[]; knownPoints: number; unverifiedCount: number;
  costs?: Omit<ComicEpisodeCostSummary, "remainingEstimate">;
};
export const comicFrameSaveSchema = z.object({
  timeMs: z.number().int().min(0).max(60_000),
  destination: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("material"), material: comicMaterialInput }).strict(),
    z.object({ kind: z.literal("character"), characterId: id, target: comicCharacterUpload }).strict(),
  ]),
}).strict();
export type ComicFrameSaveRequest = z.infer<typeof comicFrameSaveSchema>;
export const comicVideoSearchSchema = z.object({
  seriesId: id.optional(), seriesQuery: z.string().trim().max(120).optional(), adopted: z.enum(["true", "false"]).optional(),
  characterId: id.optional(),
  after: z.string().datetime().optional(), before: z.string().datetime().optional(),
  cursor: z.string().max(100).optional(),
}).strict();
export type ComicTakeState = "pending" | "running" | "ready" | "failed" | "recoverable" | "unknown" | "cancelled" | "released";
export type ComicTake = {
  id: string;
  targetId: string;
  characterTarget: ComicCharacterUpload | null;
  state: ComicImageTakeState;
  clipRevision: number | null;
  mediaId: string | null;
  error: string | null;
  createdAt: string;
  requestId: string;
  mode: ComicGenerationMode | null;
  progress: number;
  cancelRequested: boolean;
  canRecover: boolean;
  creditCheck?: ComicVideoCreditCheck | null;
};
export type ComicGenerationRequest = {
  id: string; taskId: string; kind: "image" | "video"; active: boolean; takes: ComicTake[];
};
export type ComicImageTakeState = ComicTakeState;
export type ComicImageTake = ComicTake;
export type ComicImageRequest = ComicGenerationRequest;
export type ComicKeyframeHistory = {
  approvedTakeId: string | null;
  approvedMediaId?: string | null;
  selectionRevision?: number;
  takes: ComicImageTake[];
};
export type ComicVideoTake = ComicTake & {
  seriesId: string; seriesTitle: string; scene: string; ordinal: number | null; adopted: boolean;
  version: number; modelId: string; durationMs: number; completedAt: string | null;
  posterMediaId?: string | null;
  clipSelectionRevision?: number | null;
};
export type ComicVideoHistory = { entries: ComicVideoTake[]; nextCursor: string | null };
export type ComicVideoReceipt = {
  state: "unsubmitted" | "submitting" | "accepted" | "output" | "rejected" | "unknown";
  vendorId: string | null; gatewayRequestId: string | null; httpStatus: number | null;
};
export type ComicGenerationIssue = {
  code: "MODEL_UNAVAILABLE" | "DURATION_UNSUPPORTED" | "NO_SHOTS" | "KEYFRAME_NOT_CONFIRMED" |
    "CAST_REFERENCE_MISSING" | "REFERENCE_LIMIT" | "REFERENCE_UNSUPPORTED" | "REFERENCE_MODE_CONFLICT" |
    "PROMPT_TOO_LONG" | "PROMPT_REFERENCE_UNBOUND";
  characterId?: string;
  mediaId?: string;
};

function frozenImage({ mediaId, version, mime, sizeBytes, width, height }: ComicGenerationImage): ComicGenerationImage {
  return { mediaId, version, mime, sizeBytes, width, height };
}

type ResolvedInputs = {
  series: ComicDramaSeries;
  clip: ComicDramaClip;
  cast: readonly ComicSeriesCast[];
  mode: ComicGenerationMode;
  modelId: string;
  styleDescription?: string;
  // The server resolves ownership, versions and bytes before providing these inputs.
  firstFrame?: NonNullable<ComicFrozenGenerationInput["firstFrame"]>;
  visualReferences?: ReadonlyArray<ComicGenerationReference & { kind: "style" | "scene" | "prop" }>;
};

export function buildComicGenerationInput(input: ResolvedInputs):
  { ok: true; input: ComicFrozenGenerationInput } | { ok: false; issues: ComicGenerationIssue[] } {
  const { clip, series, modelId, cast, mode } = input;
  const { draft } = clip;
  const isVideo = mode !== "keyframe";
  const profile = comicVideoProfile(modelId);
  const strictFirstFrame = mode === "from_keyframe" && !!comicVideoModel(modelId);
  const issues: ComicGenerationIssue[] = [];
  if (!modelId || (isVideo && !profile)) issues.push({ code: "MODEL_UNAVAILABLE" });
  if (isVideo && profile && !comicVideoDurationSupported(draft.durationMs, profile)) {
    issues.push({ code: "DURATION_UNSUPPORTED" });
  }
  if (!draft.shots.length || draft.shots.some(shot => !shot.description.trim())) issues.push({ code: "NO_SHOTS" });
  const firstFrame = mode === "from_keyframe" && input.firstFrame ?
    { ...frozenImage(input.firstFrame), takeId: input.firstFrame.takeId } : null;
  if (mode === "from_keyframe" && !firstFrame) issues.push({ code: "KEYFRAME_NOT_CONFIRMED" });

  const references: ComicGenerationReference[] = [];
  const descriptions: string[] = [];
  const tag = (index: number) => {
    const rule = isVideo ? profile?.imagePromptTag : undefined;
    return rule?.prefix ? rule.prefix + (index + rule.firstNumber) + rule.suffix : `reference image ${index + 1}`;
  };
  for (const actor of draft.cast ?? []) {
    const snapshot = cast.find(entry => entry.snapshot.characterId === actor.characterId)?.snapshot;
    if (!snapshot) { issues.push({ code: "CAST_REFERENCE_MISSING", characterId: actor.characterId }); continue; }
    const detail = [snapshot.name, snapshot.age, snapshot.appearance, snapshot.personality, snapshot.outfitName].filter(Boolean).join(", ");
    const actorReferences: string[] = [];
    for (const [kind, key] of [["slot", actor.slotKey], ["expression", actor.expressionKey]] as const) {
      if (!key || strictFirstFrame) continue;
      const asset = comicCastAsset(snapshot, kind, key);
      if (!asset) { issues.push({ code: "CAST_REFERENCE_MISSING", characterId: actor.characterId }); continue; }
      const { id: mediaId, mime, sizeBytes, width, height } = asset.media;
      actorReferences.push(`${tag(references.length)} is ${snapshot.name}'s ${kind === "slot" ? "appearance" : "expression"} (${key}).`);
      references.push({ mediaId, mime, sizeBytes, width, height, version: asset.version, characterId: actor.characterId,
        kind: kind === "slot" ? "appearance" : "expression", label: key });
    }
    descriptions.push(`Character: ${detail}. ${actorReferences.join(" ")}`.trim());
  }
  for (const reference of strictFirstFrame ? [] : input.visualReferences ?? []) {
    descriptions.push(`${tag(references.length)} is the ${reference.kind} reference: ${reference.label}.`);
    references.push({ ...frozenImage(reference), kind: reference.kind, label: reference.label });
  }
  if (isVideo && profile) {
    if (references.length + Number(!!firstFrame) > profile.referenceImages.total) issues.push({ code: "REFERENCE_LIMIT" });
    for (const ref of firstFrame ? [...references, firstFrame] : references) {
      if (comicReferenceImageInvalid(profile, { ...ref, size: ref.sizeBytes })) {
        issues.push({ code: "REFERENCE_UNSUPPORTED", mediaId: ref.mediaId });
      }
    }
  }
  const style = input.styleDescription ?? comicSystemDictionary.style.find(item => item.key === series.styleKey)?.labels.en ?? series.styleKey;
  const prompt = [
    `Create a ${series.aspectRatio} comic drama ${isVideo ? "clip" : "opening frame"}. Visual style: ${style}.`,
    ...(firstFrame ? ["Start from the supplied first frame and preserve its composition."] : []),
    "Keep each character's appearance and outfit consistent. Keep reference identities separate.",
    ...descriptions,
    ...(draft.scene ? [`Scene: ${draft.scene}.`] : []),
    ...draft.shots.map(shot => `Shot (${shot.durationShare}%, ${shot.framingKey}, ${shot.movementKey}): ${shot.description}`),
    ...draft.lines.filter(line => line.text).map(line => `Dialogue (${line.speaker ?? "Narrator"}): ${line.text}`),
  ].join("\n");
  if (isVideo && profile) {
    const limit = profile.promptMaxChars;
    if (limit && [...prompt].length > limit) issues.push({ code: "PROMPT_TOO_LONG" });
    if (profile.imagePromptTag.prefix === "@Image") {
      const tags = new Set(references.map((_, i) => tag(i).toLowerCase()));
      if (Array.from(prompt.matchAll(/@(image|video|audio)\d+\b/gi), match => match[0].toLowerCase()).some(ref => !tags.has(ref))) {
        issues.push({ code: "PROMPT_REFERENCE_UNBOUND" });
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, input: {
    schemaVersion: 1, promptVersion: 1, seriesId: series.id, seriesRevision: series.revision, clipId: clip.id, clipRevision: clip.revision,
    mode, modelId, aspectRatio: series.aspectRatio, durationMs: draft.durationMs, styleKey: series.styleKey, firstFrame, references, prompt,
    ...(isVideo && profile?.resolution ? { resolution: profile.resolution } : {}),
  } };
}

/** W5 records submit evidence separately from the immutable prompt and media references. */
export type ComicSubmitReceipt =
  | { state: "accepted"; providerTaskId: string; gatewayRequestId?: string }
  | { state: "rejected" | "unknown"; code: string; gatewayRequestId?: string };
export type ComicPollReceipt =
  | { state: "processing" }
  | { state: "completed"; outputUrl: string }
  | { state: "failed"; code: string };

export interface ComicGenerationProvider {
  submit(input: ComicFrozenGenerationInput, signal?: AbortSignal): Promise<ComicSubmitReceipt>;
  poll(providerTaskId: string, signal?: AbortSignal): Promise<ComicPollReceipt>;
}
