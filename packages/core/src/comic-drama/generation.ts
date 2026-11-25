import { z } from "zod";
import {
  comicVideoDurationSupported, comicVideoProfile, comicVideoResolutions,
} from "./models.js";
import { comicCastAsset, type ComicSeriesCast } from "./cast.js";
import { comicCharacterUpload, comicMaterialInput, comicSystemDictionary } from "./library.js";
import type { ComicCharacterUpload } from "./library.js";
import type { ComicDramaClip, ComicDramaSeries, ComicEpisodeCostSummary } from "./index.js";

const id = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const videoMode = z.enum(["from_keyframe", "references", "edit", "extend"]);
export const comicGenerationModeSchema = z.enum(["keyframe", ...videoMode.options]);
const targets = z.array(z.object({ clipId: id, expectedRevision: revision, replaceAdopted: z.boolean().optional() }).strict())
  .min(1).max(10).refine(items => new Set(items.map(item => item.clipId)).size === items.length);

export const comicGenerationPreviewSchema = z.object({
  expectedSeriesRevision: revision, mode: comicGenerationModeSchema, targets,
  visualReferences: z.array(z.object({ materialId: id, mediaId: id, kind: z.enum(["style", "scene", "prop"]) }).strict())
    .max(30).refine(items => new Set(items.map(item => item.mediaId)).size === items.length).optional(),
}).strict();
export const comicGenerationConfirmSchema = z.object({ confirmationId: id }).strict();
export type ComicGenerationPreviewRequest = z.infer<typeof comicGenerationPreviewSchema>;
export type ComicGenerationMode = z.infer<typeof comicGenerationModeSchema>;
export type ComicQuoteLine = {
  clipId: string; modelId: string; unit: "image" | "second"; quantity: number;
  amountMicros: number | null;
  referenceVersions?: { mediaId: string; version: number; kind?: "image" | "first_frame" | "last_frame" | "audio" | "video" }[];
  advisories?: ComicGenerationNotice[];
  sourceDurationMs?: number;
  followsSource?: boolean;
  videoEstimateDeviation?: { low: number; high: number; sampleCount: number };
};
export type ComicSkippedInvalidReference = {
  role: "style" | "scene" | "prop";
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
    issues?: ComicGenerationIssue[];
  }[];
  totalMicros: number | null;
  currency: "CNY" | "USD";
  videoTokenEstimate?: true;
};

const image = z.object({
  mediaId: id, version: revision, mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
const reference = image.extend({
  kind: z.enum(["appearance", "expression", "style", "scene", "prop", "image"]), label: z.string().min(1), characterId: id.optional(),
}).strict().refine(item => !!item.characterId === (item.kind === "appearance" || item.kind === "expression"));

const timedReference = z.object({
  mediaId: id, version: revision, sizeBytes: z.number().int().positive(), durationMs: z.number().positive(),
  label: z.string().min(1),
}).strict();
const audioReference = timedReference.extend({
  kind: z.literal("audio"), mime: z.enum(["audio/wav", "audio/mpeg"]),
  audioCodec: z.string().min(1), sampleRate: z.number().int().positive(), channels: z.number().int().positive(),
});
const videoReference = timedReference.extend({
  kind: z.literal("video"), mime: z.enum(["video/mp4", "video/quicktime"]),
  width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(),
  videoCodec: z.string().min(1), audioCodec: z.string().min(1).nullable(),
});
const timedMedia = z.discriminatedUnion("kind", [audioReference, videoReference]);
export type ComicGenerationTimedMedia = z.infer<typeof timedMedia>;

export const comicFrozenGenerationSchema = z.object({
  schemaVersion: z.literal(1), promptVersion: z.literal(1), seriesId: id, seriesRevision: revision, clipId: id, clipRevision: revision,
  mode: comicGenerationModeSchema, modelId: z.string().min(1), aspectRatio: z.enum(["9:16", "16:9", "1:1"]), durationMs: z.number().int().min(1).max(60_000),
  styleKey: z.string().min(1), firstFrame: image.extend({ takeId: id.nullable() }).nullable(), references: z.array(reference), prompt: z.string().min(1),
  resolution: z.enum(comicVideoResolutions).optional(),
  lastFrame: image.optional(),
  timedReferences: z.array(timedMedia).max(20).optional(),
  sourceDuration: z.literal(true).optional(),
}).strict().refine(item => !!item.firstFrame === (item.mode === "from_keyframe"));

export type ComicGenerationImage = z.infer<typeof image>;
export type ComicGenerationReference = z.infer<typeof reference>;
export type ComicFrozenGenerationInput = z.infer<typeof comicFrozenGenerationSchema>;
const comicMaterialTakeInput = z.object({
  schemaVersion: z.literal(1), promptVersion: z.literal(1), materialId: id,
  target: z.object({ kind: z.literal("material"), materialId: id }).strict(),
  modelId: z.string().min(1), aspectRatio: z.enum(["9:16", "16:9", "1:1"]), references: z.array(image), prompt: z.string().min(1),
}).strict();
export const comicImageTakeInput = z.union([
  comicFrozenGenerationSchema.refine(input => input.mode === "keyframe"),
  z.object({
    schemaVersion: z.literal(1), promptVersion: z.literal(1), characterId: id, target: comicCharacterUpload,
    modelId: z.string().min(1), aspectRatio: z.literal("1:1"), references: z.array(image), prompt: z.string().min(1),
  }).strict(),
  comicMaterialTakeInput,
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
const comicMaterialImageKind = z.enum(["scene", "prop"]);
const comicMaterialImageSchema = z.object({
  kind: comicMaterialImageKind, styleKey: styleKeySchema.optional(),
  prompt: z.string().trim().min(1).max(4000), referenceMediaIds: z.array(id).max(4).optional(),
}).strict();
export const comicMaterialGenerateSchema = comicMaterialImageSchema.extend({ materialId: id });
export const comicNewMaterialGenerateSchema = comicMaterialImageSchema.extend({ name: comicMaterialInput.shape.name });
export type ComicMaterialGenerateRequest = z.infer<typeof comicMaterialGenerateSchema>;
export type ComicNewMaterialGenerateRequest = z.infer<typeof comicNewMaterialGenerateSchema>;
export type ComicMaterialImageKind = z.infer<typeof comicMaterialImageKind>;
export const comicVideoTakeInput = comicFrozenGenerationSchema.refine(input => input.mode !== "keyframe");
export const comicTakeInput = z.union([comicImageTakeInput, comicVideoTakeInput]);
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
  videoMode: videoMode.default("from_keyframe"),
  redoVideos: z.array(id).max(60).optional(),
  characterImages: plannedCount, materialImages: plannedCount, speechLines: plannedCount,
  text: z.object({ inputTokens: z.number().int().min(0).max(1_000_000), outputTokens: z.number().int().min(0).max(100_000) }).strict().optional(),
}).strict();
export type ComicEpisodeBudgetInput = z.input<typeof comicEpisodeBudgetSchema>;
export type ComicEpisodeBudgetLine = {
  kind: "keyframe" | "video" | "character" | "material" | "text" | "speech";
  modelId: string | null; clipId?: string; quantity: number; inputTokens?: number; outputTokens?: number;
  estimatedPoints: number | null;
  videoTokenEstimate?: true;
};
export type ComicEpisodeBudget = {
  revision: number; items: ComicEpisodeBudgetLine[]; knownPoints: number; unverifiedCount: number;
  costs?: Omit<ComicEpisodeCostSummary, "remainingEstimate">;
  estimatedMonetaryTotals?: ComicEpisodeCostSummary["settled"];
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
export type ComicMaterialImageTake = ComicImageTake & { materialName: string; materialKind: ComicMaterialImageKind };
export type ComicImageRequest = ComicGenerationRequest;
export type ComicKeyframeHistory = {
  approvedTakeId: string | null;
  approvedMediaId?: string | null;
  selectionRevision?: number;
  takes: ComicImageTake[];
};
export type ComicVideoTake = ComicTake & {
  dramaId?: string;
  dramaTitle?: string;
  episodeNo?: number | null;
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
    "PROMPT_TOO_LONG" | "PROMPT_REFERENCE_UNBOUND" | "REFERENCE_UNVERIFIED" | "RESOLUTION_UNSUPPORTED" |
    "VIDEO_SOURCE_REQUIRED" | "VIDEO_MODE_UNSUPPORTED" | "INVALID_GENERATION_REFERENCE";
  characterId?: string;
  mediaId?: string;
  label?: string;
  field?: ComicGenerationField;
  actual?: number | string;
  min?: number;
  max?: number;
  allowed?: string;
};
type ComicGenerationField = "outputSeconds" | "images" | "audio" | "videos" | "files" | "seconds" | "audioSeconds" | "videoSeconds" |
  "bytes" | "edge" | "aspect" | "fps" | "pixels" | "format" | "codec" | "resolution" | "prompt" | "videoMode";
export type ComicGenerationNotice = {
  code: "PROMPT_LIMIT_UNVERIFIED" | "PROMPT_RECOMMENDATION"; actual?: number; max?: number; unit?: "chars" | "words";
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
  forecastFirstFrame?: boolean;
  visualReferences?: readonly ComicGenerationReference[];
  lastFrame?: ComicGenerationImage;
  timedReferences?: ComicGenerationTimedMedia[];
};

export function buildComicGenerationInput(input: ResolvedInputs):
  { ok: true; input: ComicFrozenGenerationInput } | { ok: false; issues: ComicGenerationIssue[] } {
  const { clip, series, modelId, cast, mode } = input;
  const { draft } = clip;
  const isVideo = mode !== "keyframe";
  const profile = comicVideoProfile(modelId);
  const strictFirstFrame = mode === "from_keyframe";
  const forecastFirstFrame = strictFirstFrame && input.forecastFirstFrame === true;
  const issues: ComicGenerationIssue[] = [];
  if (!modelId || (isVideo && !profile)) issues.push({ code: "MODEL_UNAVAILABLE" });
  if (!draft.shots.length || draft.shots.some(shot => !shot.description.trim())) issues.push({ code: "NO_SHOTS" });
  const firstFrame = mode === "from_keyframe" && input.firstFrame ?
    { ...frozenImage(input.firstFrame), takeId: input.firstFrame.takeId } : null;

  const lastFrame = input.lastFrame && frozenImage(input.lastFrame);
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
  if (strictFirstFrame && (input.visualReferences?.length || input.timedReferences?.length) || lastFrame && !strictFirstFrame) {
    issues.push({ code: "REFERENCE_MODE_CONFLICT" });
  }
  for (const reference of strictFirstFrame ? [] : input.visualReferences ?? []) {
    descriptions.push(`${tag(references.length)} is the ${reference.kind} reference: ${reference.label}.`);
    references.push({ ...frozenImage(reference), kind: reference.kind, label: reference.label });
  }
  const timedReferences = input.timedReferences ?? [];
  for (const kind of ["audio", "video"] as const) {
    timedReferences.filter(ref => ref.kind === kind).forEach((ref, index) => {
      const name = kind === "audio" ? "Audio" : "Video";
      const marker = profile?.imagePromptTag.prefix ? `@${name}${index + 1}` : `reference ${kind} ${index + 1}`;
      descriptions.push(`${marker} is the ${kind} reference: ${ref.label}.`);
    });
  }
  const style = input.styleDescription ?? comicSystemDictionary.style.find(item => item.key === series.styleKey)?.labels.en ?? series.styleKey;
  const prompt = [
    `Create a ${series.aspectRatio} comic drama ${isVideo ? "clip" : "opening frame"}. Visual style: ${style}.`,
    ...(firstFrame || forecastFirstFrame ? ["Start from the supplied first frame and preserve its composition."] : []),
    ...(lastFrame ? ["End on the supplied last frame."] : []),
    ...(mode === "edit" ? ["Edit the supplied source video according to the following shots and dialogue."] : []),
    ...(mode === "extend" ? ["Continue the supplied source video according to the following shots and dialogue."] : []),
    "Keep each character's appearance and outfit consistent. Keep reference identities separate.",
    ...descriptions,
    ...(draft.scene ? [`Scene: ${draft.scene}.`] : []),
    ...draft.shots.map(shot => `Shot (${shot.durationShare}%, ${shot.framingKey}, ${shot.movementKey}): ${shot.description}`),
    ...draft.lines.filter(line => line.text).map(line => `Dialogue (${line.speaker ?? "Narrator"}): ${line.text}`),
  ].join("\n");
  const sourceDuration = mode === "edit" || mode === "extend" && draft.videoInputs?.sourceDuration;
  const source = timedReferences.find(ref => ref.kind === "video");
  const frozen: ComicFrozenGenerationInput = {
    schemaVersion: 1, promptVersion: 1, seriesId: series.id, seriesRevision: series.revision, clipId: clip.id, clipRevision: clip.revision,
    mode, modelId, aspectRatio: series.aspectRatio,
    durationMs: mode === "edit" && source ? Math.round(source.durationMs)
      : sourceDuration && profile ? profile.shotMaxSeconds * 1000 : draft.durationMs,
    styleKey: series.styleKey, firstFrame, references, prompt,
    ...(isVideo && profile ? { resolution: draft.videoInputs?.resolution ?? profile.resolution } : {}),
    ...(lastFrame ? { lastFrame } : {}),
    ...(timedReferences.length ? { timedReferences } : {}),
    ...(sourceDuration ? { sourceDuration: true } : {}),
  };
  if (isVideo && profile) issues.push(...validateComicVideoInput(frozen, profile, forecastFirstFrame));
  return issues.length ? { ok: false, issues } : { ok: true, input: frozen };
}

function outside(actual: number, min: number, max: number) {
  return !Number.isFinite(actual) || actual < min || actual > max;
}

export function validateComicVideoInput(
  input: ComicFrozenGenerationInput, profile = comicVideoProfile(input.modelId), forecastFirstFrame = false,
): ComicGenerationIssue[] {
  if (!profile) return [{ code: "MODEL_UNAVAILABLE" }];
  const { mode, firstFrame, lastFrame, references, timedReferences = [], sourceDuration, durationMs, prompt } = input;
  const issues: ComicGenerationIssue[] = [];
  const audio = timedReferences.filter(ref => ref.kind === "audio");
  const videos = timedReferences.filter(ref => ref.kind === "video");
  const operation = mode === "references" ? "reference" : mode === "edit" || mode === "extend" ? mode : undefined;
  const rules = profile.referenceMedia;
  const hasFirstFrame = !!firstFrame || mode === "from_keyframe" && forecastFirstFrame;
  if (mode === "from_keyframe" && !hasFirstFrame) issues.push({ code: "KEYFRAME_NOT_CONFIRMED" });
  if (operation && !profile.operations.includes(operation)) {
    issues.push({ code: "VIDEO_MODE_UNSUPPORTED", field: "videoMode", actual: operation, allowed: profile.operations.join(" / ") });
  }
  if (!sourceDuration && !comicVideoDurationSupported(durationMs, profile) || sourceDuration && mode !== "edit" && mode !== "extend"
    || mode === "edit" && !sourceDuration) {
    issues.push({ code: "DURATION_UNSUPPORTED", field: "outputSeconds", actual: durationMs / 1000, min: 4, max: profile.shotMaxSeconds });
  }
  if (input.resolution && !profile.resolutions.includes(input.resolution)) {
    issues.push({ code: "RESOLUTION_UNSUPPORTED", field: "resolution", actual: input.resolution, allowed: profile.resolutions.join(" / ") });
  }
  if ((hasFirstFrame || lastFrame) && (references.length || timedReferences.length) || lastFrame && !hasFirstFrame
    || firstFrame && mode !== "from_keyframe"
    || audio.length && !rules.audioOnly && !references.length && !videos.length) {
    issues.push({ code: "REFERENCE_MODE_CONFLICT" });
  }
  if ((mode === "edit" || mode === "extend") && videos.length !== 1) {
    issues.push({ code: "VIDEO_SOURCE_REQUIRED", field: "videos", actual: videos.length, min: 1, max: 1 });
  }
  const limits = [
    ["files", references.length + timedReferences.length, rules.totalFiles],
    ["images", references.length, profile.referenceImages.total],
    ["audio", audio.length, rules.count], ["videos", videos.length, rules.count],
  ] as const;
  for (const [field, actual, max] of limits) {
    if (actual > max) issues.push({ code: "REFERENCE_LIMIT", field, actual, max });
  }
  for (const [kind, refs] of [["audioSeconds", audio], ["videoSeconds", videos]] as const) {
    const actual = refs.reduce((total, ref) => total + ref.durationMs, 0) / 1000;
    if (actual > profile.shotMaxSeconds) issues.push({
      code: "REFERENCE_UNSUPPORTED", field: kind, actual, max: profile.shotMaxSeconds,
    });
  }
  for (const ref of [...references, ...(firstFrame ? [firstFrame] : []), ...(lastFrame ? [lastFrame] : []), ...timedReferences]) {
    const label = "label" in ref ? ref.label : ref === firstFrame ? "first_frame" : "last_frame";
    const issue = (field: ComicGenerationField, actual: number | string, range: { min?: number; max?: number; allowed?: string }) =>
      issues.push({ code: "REFERENCE_UNSUPPORTED", mediaId: ref.mediaId, label, field, actual, ...range });
    const check = (field: ComicGenerationField, actual: number, min: number, max: number) => {
      if (outside(actual, min, max)) issue(field, actual, { ...(min ? { min } : {}), max });
    };
    const kind = "kind" in ref ? ref.kind : undefined;
    const maxBytes = kind === "audio" ? 15_000_000 : kind === "video" ? rules.videoBytes : profile.referenceImage.maxBytes;
    check("bytes", ref.sizeBytes, 0, maxBytes);
    if ("durationMs" in ref) check("seconds", ref.durationMs / 1000, mode === "edit" && kind === "video" ? 4 : 2, profile.shotMaxSeconds);
    if ("fps" in ref) {
      check("fps", ref.fps, rules.minFps, 60);
      if (rules.minPixels && rules.maxPixels) check("pixels", ref.width * ref.height, rules.minPixels, rules.maxPixels);
      const allowedAudio = ref.mime === "video/quicktime" && rules.movPcm && ref.audioCodec?.startsWith("pcm_");
      if (!["h264", "hevc"].includes(ref.videoCodec) || ref.audioCodec && !allowedAudio && !["aac", "mp3"].includes(ref.audioCodec)) {
        issue("codec", [ref.videoCodec, ref.audioCodec].filter(Boolean).join(" / "), {
          allowed: rules.movPcm ? "H.264 / H.265 + AAC / MP3 / MOV PCM" : "H.264 / H.265 + AAC / MP3",
        });
      }
    }
    if ("width" in ref) {
      const settings = kind === "video" ? rules : profile.referenceImage;
      check("edge", Math.min(ref.width, ref.height), settings.minEdge ?? 0, settings.maxEdge ?? 6000);
      const longest = Math.max(ref.width, ref.height);
      if (longest > (settings.maxEdge ?? 6000)) check("edge", longest, settings.minEdge ?? 0, settings.maxEdge ?? 6000);
      check("aspect", ref.width / ref.height, profile.referenceImage.minAspect ?? 0, profile.referenceImage.maxAspect ?? 2.5);
    }
    if (!("durationMs" in ref) && !profile.referenceImage.formats.includes(ref.mime)) {
      issue("format", ref.mime, { allowed: profile.referenceImage.formats.join(" / ") });
    }
  }
  if (profile.promptMaxChars) {
    const actual = [...prompt].length;
    if (actual > profile.promptMaxChars) issues.push({ code: "PROMPT_TOO_LONG", field: "prompt", actual, max: profile.promptMaxChars });
  }
  const counts: Record<string, number> = { image: references.length, video: videos.length, audio: audio.length };
  const names: Record<string, string> = { "图片": "image", "视频": "video", "音频": "audio" };
  for (const match of prompt.matchAll(/@(image|video|audio|图片|视频|音频)(\d+)(?![a-z0-9_])/gi)) {
    const name = match[1].toLowerCase();
    const number = Number(match[2]);
    if (!number || number > counts[names[name] ?? name] || String(number) !== match[2]) {
      issues.push({ code: "PROMPT_REFERENCE_UNBOUND", field: "prompt", actual: match[0] });
    }
  }
  return issues;
}

export function comicVideoPromptNotices(input: ComicFrozenGenerationInput): ComicGenerationNotice[] {
  const profile = comicVideoProfile(input.modelId);
  const notices: ComicGenerationNotice[] = [];
  if (profile?.promptLimitUnverified) notices.push({ code: "PROMPT_LIMIT_UNVERIFIED" });
  if (profile?.promptRecommendation) {
    const { chineseChars, englishWords } = profile.promptRecommendation;
    const chars = [...input.prompt.matchAll(/\p{Script=Han}/gu)].length;
    const words = [...input.prompt.matchAll(/[a-z]+(?:['’-][a-z]+)*/gi)].length;
    if (chars > chineseChars) notices.push({ code: "PROMPT_RECOMMENDATION", actual: chars, max: chineseChars, unit: "chars" });
    if (words > englishWords) notices.push({ code: "PROMPT_RECOMMENDATION", actual: words, max: englishWords, unit: "words" });
  }
  return notices;
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
