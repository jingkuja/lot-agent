import { z } from "zod";
import type { MarketingCaption, MarketingCaptionTiming } from "./captions.js";
import { KLING_MARKETING_PROFILE, MARKETING_MAX_SECTION_IMAGES, marketingVideoProfile, type MarketingVideoProfile } from "./models.js";

export * from "./models.js";

export const MARKETING_COPY_MODEL = "kimi-k3.1-pro";
/** Copy and storyboard requests use this model for 30 minutes after the default one fails. */
export const MARKETING_COPY_FALLBACK_MODEL = "kimi-k3";
/** ...and this one for 30 minutes after the fallback also fails. */
export const MARKETING_COPY_LAST_RESORT_MODEL = "deepseek-v4.1-flash";
/** Fixed reasoning effort per copy model; others keep their default. Unset, kimi-k3.1-pro thinks until the output limit
 * runs out (13k of 16384 tokens for a 60-second storyboard, ~400 s); Kimi treats `none` as max. At medium it used under
 * 1.4k reasoning tokens and kept to the supplied facts (gateway runs on 2026-10-28). */
export const MARKETING_COPY_REASONING_EFFORT: Readonly<Record<string, "medium">> = { [MARKETING_COPY_MODEL]: "medium" };
/** Risk review only quotes and replaces excerpts; a fast model keeps re-checks after each edit short. */
export const MARKETING_REVIEW_MODEL = "deepseek-v4.1-flash";
export const MarketingShotSchema = z.object({
  // Existing saved boards predate per-shot timing and used 15-second clips.
  durationSec: z.number().int().min(4).max(15).default(15),
  script: z.string().max(600),
  visual: z.string().max(600),
  action: z.string().max(400),
  camera: z.string().max(400),
}).strict();
export const MarketingStoryboardSchema = z.array(MarketingShotSchema).max(15);
export type MarketingShot = z.infer<typeof MarketingShotSchema>;

export const MarketingCreationSchema = z.object({
  shots: MarketingStoryboardSchema,
  publishTitle: z.string().trim().min(1).max(100),
  tags: z.string().max(160),
  analysis: z.string().trim().min(1).max(2000),
  continuity: z.string().trim().max(400).optional(),
}).strict();

// Per-model section and total limits are checked by marketingReferenceError, so stored
// drafts and frozen jobs keep loading after the active model changes.
const MarketingImagesSchema = z.union([z.string().uuid(), z.array(z.string().uuid()).min(1).max(MARKETING_MAX_SECTION_IMAGES)]);
export function marketingAssetIds(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
/** Image slots in submission order: identity, then product, then setting. */
export const MARKETING_IMAGE_SLOTS = ["portrait", "product", "background", "scene"] as const;
export type MarketingImageSlot = typeof MARKETING_IMAGE_SLOTS[number];
/** Studio sections with their own limit; background and scene share `setting`. */
export type MarketingImageSection = keyof Omit<MarketingVideoProfile["referenceImages"], "total">;
export const marketingImageSection = (slot: MarketingImageSlot): MarketingImageSection =>
  slot === "background" || slot === "scene" ? "setting" : slot;
/** Selected images in a section, or in all sections when omitted. */
export function marketingImageCount(assets: Partial<Record<MarketingImageSlot, string | string[]>>, section?: MarketingImageSection): number {
  return MARKETING_IMAGE_SLOTS.filter(slot => !section || marketingImageSection(slot) === section)
    .reduce((sum, slot) => sum + marketingAssetIds(assets[slot]).length, 0);
}

/** Older drafts may hold a cover image that never reached generation. Drop it before
 * strict parsing, so stored drafts and frozen jobs keep loading. */
function withoutLegacyCover(value: unknown) {
  const assets = value && typeof value === "object" ? (value as { assets?: unknown }).assets : undefined;
  if (!assets || typeof assets !== "object" || !("cover" in assets)) return value;
  const { cover: _cover, ...rest } = assets as Record<string, unknown>;
  return { ...(value as object), assets: rest };
}
/** The studio once had a separate setting description beside the shared look. It reads as part
 * of the shared look now, so one field describes the setting. */
function withoutLegacyBackground(value: unknown) {
  const draft = value && typeof value === "object" ? value as { background?: unknown; continuity?: unknown } : undefined;
  const background = typeof draft?.background === "string" ? draft.background.trim() : "";
  if (!background || background === MARKETING_DEFAULT_BACKGROUND) return value;
  const continuity = typeof draft!.continuity === "string" ? draft!.continuity.trim() : "";
  return { ...draft, background: "", continuity: [continuity, background].filter(Boolean).join("\n").slice(0, MARKETING_CONTINUITY_MAX_LENGTH) };
}
/** Off-screen narration in the user's own cloned voice (digital twin), synthesized per shot
 * before any clip is paid for. Absent: the video model voices the script itself. */
export const MarketingNarrationSchema = z.object({
  /** Digital twin voice item; synthesis needs its cloned voice to be ready. */
  twinItemId: z.string().uuid().optional(),
  /** Display only, so the draft shows the chosen voice without another lookup. */
  voiceName: z.string().max(255).optional(),
  speed: z.number().min(0.8).max(1.25).default(1),
  instructions: z.string().trim().max(200).default(""),
}).strict();
export type MarketingNarration = z.infer<typeof MarketingNarrationSchema>;
const CaptionOffsetSchema = z.number().min(-1).max(1);
/** How locally burned captions look and when they show. A made video composes again with
 * changes here, without the video model. */
export const MarketingCaptionsSchema = z.object({
  size: z.enum(["small", "medium", "large"]).default("medium"),
  position: z.enum(["low", "medium", "high"]).default("medium"),
  /** A colour preset of `MARKETING_CAPTION_COLORS`. */
  color: z.enum(["white", "yellow", "black", "box", "yellow-box"]).default("white"),
  /** Seconds every caption moves; negative shows them earlier. */
  offsetSec: CaptionOffsetSchema.default(0),
  /** Per shot; an entry applies only while its shot still says `script`. `lines` may move
   * line breaks and punctuation, never the words. */
  shots: z.array(z.object({
    script: z.string().max(600),
    lines: z.array(z.string().trim().min(1).max(200)).min(1).max(40).optional(),
    offsetSec: CaptionOffsetSchema.default(0),
  }).strict().nullable()).max(15).default([]),
}).strict();
export type MarketingCaptions = z.infer<typeof MarketingCaptionsSchema>;
/** The setting drafts once stored as their default, shown as Chinese text in every language; it
 * reads as empty now. The key-art prompt still names it (see `marketingKeyArtPrompt`). */
export const MARKETING_DEFAULT_BACKGROUND = "简约演播室";
/** The tone drafts once stored as their default; it reads as empty now. */
export const MARKETING_DEFAULT_VOICE = "自然旁白";
/** Model prompts are English whatever the interface language, defaults included. */
export const MARKETING_PROMPT_BACKGROUND = "minimal studio";
export const MARKETING_PROMPT_VOICE = "natural narration";
/** Room for a shared look of 400 characters joined with an older setting description of up to 600. */
const MARKETING_CONTINUITY_MAX_LENGTH = 1000;
export const MarketingDraftSchema = z.preprocess(value => withoutLegacyBackground(withoutLegacyCover(value)), z.object({
  topic: z.string().max(800).default(""),
  copyMode: z.enum(["generate", "rewrite"]).default("generate"),
  reference: z.string().max(6000).default(""),
  referenceUpload: z.object({ id: z.string().uuid(), name: z.string().min(1).max(255) }).strict().optional(),
  script: z.string().max(2000).default(""),
  durationSec: z.number().int().min(15).max(60).default(30),
  // Only digital-presenter videos exist; drafts may still hold the never-offered "recorded".
  mode: z.literal("avatar").catch("avatar"),
  // "always": presenter in every shot. "mixed": the storyboard decides per shot whether the presenter
  // is on camera and how they are framed; others may show the venue, dishes or products.
  // New drafts start "mixed" (`newMarketingDraft`); drafts and jobs saved without the field stay "always".
  presenter: z.enum(["always", "mixed"]).default("always"),
  /** Always empty once parsed: the setting is part of `continuity`. Kept so stored drafts, checks and jobs keep loading. */
  background: z.string().max(600).default("").transform(value => value === MARKETING_DEFAULT_BACKGROUND ? "" : value),
  /** Tone of the video model's own voice, written by the user. */
  voice: z.string().max(100).default("").transform(value => value === MARKETING_DEFAULT_VOICE ? "" : value),
  ratio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  quality: z.enum(["720p", "1080p"]).default("720p"),
  subtitles: z.boolean().default(true),
  captions: MarketingCaptionsSchema.optional(),
  musicVolume: z.number().min(0).max(0.5).default(0.12),
  assets: z.object({
    portrait: MarketingImagesSchema.optional(), background: MarketingImagesSchema.optional(),
    scene: MarketingImagesSchema.optional(),
    /** Product samples that anchor the product's look (shape, colors, packaging, labels). */
    product: MarketingImagesSchema.optional(),
    voice: z.string().uuid().optional(), video: z.string().uuid().optional(),
    music: z.string().uuid().optional(),
  }).strict().refine(assets => marketingImageCount(assets) <= MARKETING_MAX_SECTION_IMAGES * 3, { message: "参考图片过多。" }).default({}),
  storyboard: MarketingStoryboardSchema.default([]),
  /** Presenter and setting look shared by all shots; every clip request repeats it verbatim
   * because each clip is generated independently. */
  continuity: z.string().max(MARKETING_CONTINUITY_MAX_LENGTH).default(""),
  /** Whether the board was planned for native speech (no reference video). Absent on
   * boards planned before this was recorded. */
  storyboardAudio: z.boolean().optional(),
  narration: MarketingNarrationSchema.optional(),
  publishTitle: z.string().max(100).default(""),
  tags: z.string().max(160).default(""),
}).strict());
export type MarketingDraft = z.infer<typeof MarketingDraftSchema>;
/** A blank draft as the studio starts one. */
export const newMarketingDraft = (): MarketingDraft => MarketingDraftSchema.parse({ presenter: "mixed" });
/** True when the board was planned for the other audio setting: speech written for a
 * silent reference-video render, or silent demonstration for a narrated one. */
export function marketingStoryboardAudioMismatch(draft: MarketingDraft): boolean {
  return !!draft.storyboard.length && draft.storyboardAudio !== undefined && draft.storyboardAudio === !!draft.assets.video;
}
/** Twin narration replaces the clips' audio. A reference video renders a silent film, so it has none. */
export const marketingVoiceover = (draft: Pick<MarketingDraft, "narration" | "assets">) => !!draft.narration && !draft.assets.video;
/** Whether new clips are asked to speak the script themselves. */
export const marketingNativeSpeech = (draft: Pick<MarketingDraft, "narration" | "assets">) => !draft.narration && !draft.assets.video;
/** Frozen input format. Versions before 2 predate reference checks; version 4 adds
 * twin narration. Rules always come from the profile of the recorded `modelId`. */
export const MARKETING_INPUT_VERSION = 4;

/** Profile of a frozen job; inputs without a model id were submitted to Kling. */
export function marketingJobProfile(input: { modelId?: unknown }): MarketingVideoProfile {
  const profile = marketingVideoProfile(typeof input.modelId === "string" ? input.modelId : KLING_MARKETING_PROFILE.modelId);
  if (!profile) throw new Error("原任务使用的视频模型已不受支持，请复制为新草稿后重新制作。");
  return profile;
}

// One whole sentence per section, so each translates as a unit.
const MARKETING_IMAGE_SECTION_LIMITS: Record<MarketingImageSection, (limit: number) => string> = {
  portrait: limit => `当前视频模型的人物图片最多 ${limit} 张，请移除多余图片。`,
  product: limit => `当前视频模型的产品图片最多 ${limit} 张，请移除多余图片。`,
  setting: limit => `当前视频模型的场景图片最多 ${limit} 张，请移除多余图片。`,
};
/** Section or total image limit of the model that `assets` exceed. */
export function marketingImageLimitError(assets: Partial<Record<MarketingImageSlot, string | string[]>>, profile: MarketingVideoProfile): string {
  for (const section of ["portrait", "product", "setting"] as const) {
    const limit = profile.referenceImages[section];
    if (marketingImageCount(assets, section) > limit) return MARKETING_IMAGE_SECTION_LIMITS[section](limit);
  }
  const { total } = profile.referenceImages;
  return marketingImageCount(assets) > total ? `当前视频模型的参考图片合计最多 ${total} 张，请移除多余图片。` : "";
}
/** Setting description sent to the models. */
export const marketingBackground = (draft: Pick<MarketingDraft, "background">) => draft.background.trim() || MARKETING_PROMPT_BACKGROUND;
/** Tone sent to the video model when it voices the script. */
export const marketingVoiceStyle = (draft: Pick<MarketingDraft, "voice">) => draft.voice.trim() || MARKETING_PROMPT_VOICE;
/** Reference combinations the model cannot use. `keyArt`: the clips also carry the key-art still,
 * which is one more reference image. */
export function marketingReferenceError(draft: MarketingDraft, profile: MarketingVideoProfile, keyArt = false): string {
  const images = marketingImageCount(draft.assets);
  if (draft.assets.video && images > profile.imagesWithReferenceVideo) {
    return profile.imagesWithReferenceVideo
      ? `已选择动作参考视频，参考图片合计不能超过 ${profile.imagesWithReferenceVideo} 张，请移除多余图片。`
      : "已选择动作参考视频，参考图片不会参与生成，请移除图片或动作参考视频。";
  }
  const limitError = marketingImageLimitError(draft.assets, profile);
  if (limitError) return limitError;
  if (draft.quality === "1080p" && marketingHdUnavailable(draft, profile)) return "使用参考图片或动作参考视频时最高支持 720p，请将画质改为 720p。";
  if (draft.quality === "1080p" && marketingHdUnavailable(draft, profile, keyArt)) return "使用定妆图时最高支持 720p，请将画质改为 720p。";
  return "";
}
/** Whether the model renders this draft at 720p at most: it does with any reference image, reference video or the key-art still. */
export const marketingHdUnavailable = (draft: Pick<MarketingDraft, "assets">, profile: MarketingVideoProfile, keyArt = false) =>
  profile.referenceMaxQuality === "720p" && (!!marketingImageCount(draft.assets) || !!draft.assets.video || keyArt);
/** Why a key-art still cannot join this draft's clips: a reference video is used instead of
 * images ("video"), or the still's reference image place is taken ("full"). */
export function marketingKeyArtIssue(draft: Pick<MarketingDraft, "assets">, profile: MarketingVideoProfile): "video" | "full" | undefined {
  if (draft.assets.video) return "video";
  return marketingImageCount(draft.assets) >= profile.referenceImages.total ? "full" : undefined;
}
/** The key-art still of a draft's current look (presenter, setting and reference images).
 * missing: none was made for this look yet. */
export interface MarketingKeyArt {
  status: "missing" | "running" | "succeeded" | "failed";
  /** Short-lived preview link of a succeeded still. */
  url?: string;
  /** Why the newest attempt failed; an earlier still of the same look may still be shown. */
  error?: string;
  /** The newest attempt was paid for and only its download or wait was cut short: trying again
   * fetches that result without a new image request. */
  resumable?: boolean;
  /** How long the running still has been made, measured on the server so a refresh keeps the time. */
  elapsedMs?: number;
}
/** A still usually takes up to this long; past it the studio asks for patience and a running still may be made again. */
export const MARKETING_KEY_ART_PATIENCE_MS = 120_000;
/** The longest wait for a still; a task still running then stops and can be fetched again without a new charge. */
export const MARKETING_KEY_ART_LONGEST_MS = 300_000;
/** Local checks of a composed video; no model is called. Times are seconds in the film. */
export interface MarketingQualityIssue {
  kind: "silence" | "black" | "freeze";
  /** 0-based shot the issue starts in. */
  shot: number;
  start: number; end: number;
}
export interface MarketingQualityReport {
  /** False when the checks could not run; the video itself was still made. */
  checked: boolean;
  durationSec: number; expectedSec: number;
  /** burned: captions from the confirmed copy were burned in locally (`captions` cues);
   * model: drawn by the video model, not checked; off: no captions. */
  subtitles: "burned" | "model" | "off";
  captions?: number;
  /** Whether the speech track was checked for silence; a reference-video film is silent. */
  speech: boolean;
  issues: MarketingQualityIssue[];
}
export const MarketingReviewFieldSchema =z.enum(["script", "publishTitle", "tags", "background", "continuity", "storyboard.script", "storyboard.visual", "storyboard.action", "storyboard.camera"]);
export const MarketingReviewIssueSchema = z.object({
  text: z.string().min(1).max(2000), reason: z.string().min(1).max(500), suggestion: z.string().max(2000),
  // Optional only for compatibility with already saved review cards.
  field: MarketingReviewFieldSchema.optional(), shotIndex: z.number().int().min(0).max(14).optional(),
  ruleId: z.string().max(80).optional(), source: z.enum(["risk-table", "douyin", "xiaohongshu"]).optional(),
  severity: z.enum(["suspect", "reject"]).optional(),
}).strict();
export type MarketingReviewIssue = z.infer<typeof MarketingReviewIssueSchema>;
export type MarketingReviewField = z.infer<typeof MarketingReviewFieldSchema>;
export const MarketingReviewSchema = z.object({
  verdict: z.enum(["pass", "suspect", "reject"]),
  issues: z.array(MarketingReviewIssueSchema).max(80),
  /** Model findings left out because their excerpt or rule could not be located in the draft. */
  dropped: z.number().int().min(1).max(80).optional(),
  ruleVersion: z.string().max(80).optional(),
  reviewedAt: z.string().datetime().optional(),
}).strict();
export type MarketingReview = z.infer<typeof MarketingReviewSchema>;
export interface MarketingSegment { index: number; script: string; durationSec: number; }
/** Why a video task stopped. The worker stores it with the error text; the UI maps
 * it to guidance, so rewording a message never changes the offered actions. */
export const MARKETING_FAILURE_CODES = [
  "CONNECT_FAILED", "REAL_PERSON_REJECTED", "MODEL_AUTH_REQUIRED", "CONFIG_MISSING", "MODEL_QUOTA", "MODEL_RATE_LIMIT",
  "JOB_BUSY", "DOWNLOAD_INCOMPLETE", "GENERATION_FAILED", "TIMED_OUT", "STATUS_UNCONFIRMED", "QUALITY_CHECK_FAILED",
  "NOT_RECOVERABLE", "COMPOSITION_FAILED", "SUBMISSION_UNKNOWN", "NARRATION_INVALID", "GATEWAY_FAILED",
] as const;
export type MarketingFailureCode = typeof MARKETING_FAILURE_CODES[number];
export function isMarketingFailureCode(value: unknown): value is MarketingFailureCode {
  return MARKETING_FAILURE_CODES.includes(value as MarketingFailureCode);
}
export interface MarketingProject {
  referenceAnalysis?: { id: string; acceptedRevision: number; evidenceIds: string[] };
  id: string; version: number; draft: MarketingDraft; updatedAt: string;
  review: MarketingReview | null; reviewedScript: string | null;
  taskId: string | null; status: string; progress: number; stage?: string;
  error?: string; errorCode?: MarketingFailureCode;
  /** `quality`: local checks of the made video; absent on videos made before them.
   * `captions`: the cues burned in locally. `preview`: the same video without them, and
   * `captionTiming` what timing them needs, so caption changes can be watched before composing
   * again (M08); absent on videos composed before. */
  output?: { assetIds: string[]; assets: { url: string; mime: string }[]; quality?: MarketingQualityReport; captions?: MarketingCaption[];
    preview?: { assetId: string; url: string }; captionTiming?: MarketingCaptionTiming[] };
  knowledgeItemId: string | null;
  knowledgeVersion?: number | null;
  /** Saved earlier versions of the copy and storyboard that can be restored; absent when none. */
  snapshots?: number;
  /** Clips of the current job whose paid submission outcome is unknown. */
  unknownSegments?: number;
  /** Set when single shots of the current stopped or finished job can be redone: the
   * draft it rendered, its clip model, which of its clips can be kept unpaid, and what its
   * local composition adds to them. */
  revision?: { draft: MarketingDraft; modelId: string; reusable: boolean[]; composition: MarketingComposition;
    /** Each kept clip's video, to watch a shot before redoing it; null when it has none. */
    clips?: (string | null)[] };
  /** The newest made video of an earlier job of this draft, while the current job has not made one:
   * a redo or recomposition that is running or stopped never hides the last usable video. */
  previousResult?: { taskId: string; url: string };
  /** The made video the current job previews a replacement for. It stays until the preview is kept, which removes
   * it, or discarded, which makes it current again. */
  previewBase?: { taskId: string; url: string };
}
/** Saved earlier copy and storyboard of a draft (assessment M04), kept before an AI result replaced
 * them (`copy`, `storyboard`), a save dropped the shots (`clear`) or a restore replaced them (`restore`). */
export interface MarketingDraftSnapshot {
  id: string; reason: "copy" | "storyboard" | "clear" | "restore"; createdAt: string;
  shots: number; durationSec: number;
  /** The start of its copy, to recognise it. */
  excerpt: string;
}
/** Earlier versions kept per draft. */
export const MARKETING_SNAPSHOT_LIMIT = 10;
/** What a snapshot holds and restoring it puts back: the copy, shots and publishing text. Materials,
 * voice and picture settings stay as they are now. */
export const marketingDraftContent = ({ script, storyboard, storyboardAudio, continuity, publishTitle, tags }: MarketingDraft) =>
  ({ script, storyboard, storyboardAudio, continuity, publishTitle, tags });
export const restoreMarketingDraft = (current: MarketingDraft, saved: MarketingDraft): MarketingDraft =>
  MarketingDraftSchema.parse({ ...current, ...marketingDraftContent(saved) });
/** What a page polls while a video is being made: task fields only, no draft or material links. */
export type MarketingTaskState = Pick<MarketingProject, "id" | "version" | "taskId" | "status" | "progress" | "stage" | "error" | "errorCode" | "output" | "unknownSegments">;
/** A store is owner-scoped even for worker reads; infrastructure lives in server. */
export interface MarketingProjectStore {
  get(owner: string, id: string): Promise<MarketingProject | null>;
  list(owner: string): Promise<MarketingProject[]>;
  save(owner: string, id: string, version: number, draft: MarketingDraft): Promise<MarketingProject>;
}

/** Rough copy budget only. Actual narration and lip alignment need an audio provider. */
export function speechUnits(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff]/g)?.length ?? 0;
  const words = text.replace(/[\u3400-\u9fff\u3040-\u30ff]/g, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return cjk + words * 2;
}
// Three paces, each for one job. The studio shows the estimate as the range between the fastest and the
// planning pace next to the longest allowed video, so copy the checks accept never looks too long.
/** Speech units per second that copy is planned and estimated at; prompts ask for no more. */
export const MARKETING_SPEECH_PACE = 4;
/** The fastest pace a shot's line may need. A longer line does not fit its shot. */
export const MARKETING_MAX_SPEECH_PACE = 4.5;
/** Pace that decides how many clips a script split without AI needs; slower, so each clip has room to breathe. */
export const MARKETING_SPLIT_SPEECH_PACE = 3.5;
/** Whole seconds a line needs at the fastest allowed pace. */
export const marketingSpeechMinimumSeconds = (text: string) => Math.ceil(speechUnits(text) / MARKETING_MAX_SPEECH_PACE);
/** Estimated speaking time of a script at the planning pace. */
export const marketingSpeechSeconds = (text: string) => Math.ceil(speechUnits(text) / MARKETING_SPEECH_PACE);
/** Estimated speaking time as "fastest–planned" whole seconds, or one number when both agree. */
export function marketingSpeechEstimate(text: string): string {
  const fastest = marketingSpeechMinimumSeconds(text), planned = marketingSpeechSeconds(text);
  return fastest === planned ? String(planned) : `${fastest}–${planned}`;
}

/** The selected duration is a target; allow up to five extra seconds for pacing. */
export const marketingMaxDuration = (target: number) => Math.min(65, target + 5);
export const isMarketingDurationValid = (target: number, actual: number) => Number.isInteger(target) && target >= 15 && target <= 60
  && Number.isInteger(actual) && actual >= target && actual <= marketingMaxDuration(target);

/** Schema and storyboard upper bound shared by every model. */
export const MARKETING_SHOT_MAX_SECONDS = 15;
/** Longest shot the model accepts for this draft. */
export function marketingShotMaxSeconds(draft: Pick<MarketingDraft, "assets">, profile: MarketingVideoProfile): number {
  return Math.min(MARKETING_SHOT_MAX_SECONDS, draft.assets.video ? profile.referenceVideoShotMaxSeconds : profile.shotMaxSeconds);
}

/** Keep the AI's valid timing, or apportion integer seconds by its pacing
 * weights, bounded by narration length and the model's 4–maxShot second range.
 * `measured` gives single shots a measured minimum, e.g. the seconds a narration take
 * needs, in place of the estimate from their text. Once anything is measured, the
 * board is no longer than the target or what the shots need: every second is billed. */
export function allocateShotDurations(shots: { script: string; durationSec?: number }[], target: number, maxShot = MARKETING_SHOT_MAX_SECONDS, measured: (number | undefined)[] = []): number[] {
  const maximum = marketingMaxDuration(target);
  if (!isMarketingDurationValid(target, target) || !shots.length || shots.length > 15
    || shots.length * 4 > maximum || shots.length * maxShot < target) throw new Error("分镜数量与视频时长不一致，请重新生成分镜。");
  const minimum = shots.map((shot, i) => Math.max(4, measured[i] ?? marketingSpeechMinimumSeconds(shot.script)));
  const minimumTotal = minimum.reduce((a, b) => a + b, 0);
  if (minimum.some(n => n > maxShot) || minimumTotal > maximum) throw new Error("文案过长，请精简文案或增加视频时长。");
  const total = Math.max(target, minimumTotal);
  const requested = shots.map(shot => shot.durationSec ?? 0);
  const requestedTotal = requested.reduce((a, b) => a + b, 0);
  if (requested.every((n, i) => Number.isInteger(n) && n >= minimum[i] && n <= maxShot) && isMarketingDurationValid(target, requestedTotal)
    && (requestedTotal <= total || !measured.some(n => n !== undefined))) return requested;
  const weights = shots.map(shot => Math.max(1, shot.durationSec ?? speechUnits(shot.script)));
  const result = [...minimum];
  for (let remaining = total - result.reduce((a, b) => a + b, 0); remaining > 0; remaining--) {
    let best = -1;
    for (let i = 0; i < result.length; i++) if (result[i] < maxShot && (best < 0 || weights[i] / (result[i] + 1) > weights[best] / (result[best] + 1))) best = i;
    result[best]++;
  }
  return result;
}

export function timeMarketingStoryboard(shots: MarketingShot[], total: number, maxShot = MARKETING_SHOT_MAX_SECONDS): MarketingShot[] {
  const durations = allocateShotDurations(shots, total, maxShot);
  return shots.map((shot, index) => ({ ...shot, durationSec: durations[index] }));
}

/** Silence kept after a shot's narration; the clip must outlast its voice-over. */
export const MARKETING_NARRATION_TAIL_MS = 200;
export const marketingNarrationFits = (durationMs: number, durationSec: number) => durationMs + MARKETING_NARRATION_TAIL_MS <= durationSec * 1000;
/** Shortest whole-second shot that holds this narration with a short pause. */
export const marketingNarrationShotMinimum = (durationMs: number) => Math.max(4, Math.ceil((durationMs + 400) / 1000));
/** Time shots to their measured narration within the draft's duration range: lengthen shots
 * whose take does not fit, and shorten a board that runs past both the target and what the
 * takes need, so shots do not end in long silences that are billed as video. Shots keep
 * their time when that already holds. */
export function fitMarketingNarration(shots: MarketingShot[], draft: Pick<MarketingDraft, "assets" | "durationSec">, profile: MarketingVideoProfile, durationsMs: (number | undefined)[]): MarketingShot[] {
  const maxShot = marketingShotMaxSeconds(draft, profile);
  const floor = durationsMs.map(ms => ms === undefined ? undefined : marketingNarrationShotMinimum(ms));
  if (floor.some(n => n !== undefined && n > maxShot)) throw new Error(`有分镜的配音超过 ${maxShot} 秒，请精简该镜口播或调快语速。`);
  let durations: number[];
  try { durations = allocateShotDurations(shots, draft.durationSec, maxShot, floor); }
  catch { throw new Error("配音总时长超过视频时长上限，请精简文案、调快语速或增加视频时长。"); }
  return shots.map((shot, index) => ({ ...shot, durationSec: durations[index] }));
}
/** Seconds fitting would take off a board, e.g. one timed from its text before the takes were
 * measured; 0 while a take is missing or nothing can be saved. */
export function marketingNarrationSpareSec(shots: MarketingShot[], draft: Pick<MarketingDraft, "assets" | "durationSec">, profile: MarketingVideoProfile, durationsMs: (number | undefined)[]): number {
  if (!shots.length || durationsMs.length !== shots.length || durationsMs.some(ms => ms === undefined)) return 0;
  const total = (list: MarketingShot[]) => list.reduce((sum, shot) => sum + shot.durationSec, 0);
  try { return Math.max(0, total(shots) - total(fitMarketingNarration(shots, draft, profile, durationsMs))); }
  catch { return 0; }
}
/** One shot's narration state as the studio shows it. */
export interface MarketingNarrationClip {
  slot: number;
  /** missing: not synthesized for the current text and voice settings. */
  status: "missing" | "running" | "succeeded" | "failed";
  durationMs?: number;
  /** Why a failed take failed. */
  error?: string;
}

/** Re-time saved shots that exceed the draft's cap, e.g. after a reference video is added. */
export function capMarketingStoryboard(shots: MarketingShot[], draft: Pick<MarketingDraft, "assets" | "durationSec">, profile: MarketingVideoProfile): MarketingShot[] {
  const maxShot = marketingShotMaxSeconds(draft, profile);
  if (!shots.some(shot => (shot.durationSec ?? MARKETING_SHOT_MAX_SECONDS) > maxShot)) return shots;
  try { return timeMarketingStoryboard(shots, draft.durationSec, maxShot); }
  catch { throw new Error(`当前视频模型每镜最长 ${maxShot} 秒，请重新生成全部分镜。`); }
}

/** Most shots a storyboard holds (migration 41). */
const MARKETING_STORYBOARD_MAX_SHOTS = 15;
/** Split at sentence ends, else phrase boundaries, about one copy beat per shot. Segment times are integers accepted by the video model. */
export function planMarketingSegments(script: string, durationSec: number, maxShot = MARKETING_SHOT_MAX_SECONDS): MarketingSegment[] {
  if (!Number.isInteger(durationSec) || durationSec < 15 || durationSec > 60 || !script.trim()) throw new Error("请填写文案并选择 15–60 秒的整片时长。");
  const units = speechUnits(script);
  if (units > marketingMaxDuration(durationSec) * MARKETING_MAX_SPEECH_PACE) throw new Error("文案过长，请精简文案或增加视频时长。");
  // One shot per sentence, kept to 5–8 seconds a shot on average, never fewer than the length and narration
  // need, and each with at least 4 seconds and 4 speech units. A split that does not fit tries one shot fewer.
  const needed = Math.max(Math.ceil(durationSec / maxShot), Math.ceil(units / (maxShot * MARKETING_SPLIT_SPEECH_PACE)));
  if (units < needed * 4) throw new Error("文案过短，请补充内容。");
  if (Array.from(script.trim()).length < needed) throw new Error("文案过短，请补充内容。");
  const beats = Math.min(Math.max(marketingSentences(script.trim()).length, Math.round(durationSec / 8)), Math.round(durationSec / 5));
  const preferred = Math.max(needed, Math.min(beats, Math.floor(units / 4), Math.floor(marketingMaxDuration(durationSec) / 4), MARKETING_STORYBOARD_MAX_SHOTS));
  for (let count = preferred; ; count--) {
    try { return splitMarketingScript(script.trim(), count, durationSec, maxShot); }
    catch (error) { if (count <= needed) throw error; }
  }
}

/** The copy's sentences, joining back to it exactly; a piece without speech joins its neighbour. */
function marketingSentences(script: string): string[] {
  const sentences: string[] = [];
  for (const piece of script.split(/(?<=[。！？.!?；;\n])/u)) {
    if (sentences.length && (!speechUnits(piece) || !speechUnits(sentences[sentences.length - 1]))) sentences[sentences.length - 1] += piece;
    else sentences.push(piece);
  }
  return sentences;
}

/** Whole sentences in `count` shots of as even speech length as possible. */
function groupMarketingSentences(sentences: string[], count: number): string[] {
  const sums = sentences.reduce((list, text) => [...list, list.at(-1)! + speechUnits(text)], [0]);
  const mean = sums.at(-1)! / count;
  const cost = (from: number, to: number) => (sums[to] - sums[from] - mean) ** 2;
  // best[k][j]: the cheapest way to put the first j sentences in k shots; from[k][j] where its last shot starts.
  const best = [sums.map((_, j) => j ? Infinity : 0)];
  const from: number[][] = [[]];
  for (let k = 1; k <= count; k++) {
    best.push(sums.map(() => Infinity)); from.push([]);
    for (let j = k; j < sums.length; j++) for (let i = k - 1; i < j; i++) {
      const total = best[k - 1][i] + cost(i, j);
      if (total < best[k][j]) { best[k][j] = total; from[k][j] = i; }
    }
  }
  const parts: string[] = [];
  for (let k = count, j = sentences.length; k > 0; j = from[k][j], k--) parts.unshift(sentences.slice(from[k][j], j).join(""));
  return parts;
}

// Preserve every character, including whitespace and punctuation. Long
// sentences may be split at a comma, space, or ultimately a character edge.
function splitMarketingEvenly(chars: string[], count: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const remaining = chars.length - start;
    const target = start + Math.round(remaining / (count - i));
    const lower = start + Math.max(1, Math.floor(remaining / (count - i) * 0.65));
    const upper = Math.min(chars.length - (count - i - 1), start + Math.ceil(remaining / (count - i) * 1.2));
    const window = Array.from({ length: Math.max(0, upper - lower + 1) }, (_, n) => lower + n);
    const nearest = (ends: number[]) => ends.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    // A sentence end is a copy beat; a comma or space only when the window holds none.
    const end = nearest(window.filter(n => /[。！？.!?；;\n]/u.test(chars[n - 1])))
      ?? nearest(window.filter(n => /[，,\s]/u.test(chars[n - 1]))) ?? target;
    parts.push(chars.slice(start, end).join("")); start = end;
  }
  parts.push(chars.slice(start).join(""));
  return parts;
}

/** Whole sentences per shot when they fit, else the even split. */
function splitMarketingScript(script: string, count: number, durationSec: number, maxShot: number): MarketingSegment[] {
  const sentences = marketingSentences(script);
  const splits = [...sentences.length >= count ? [groupMarketingSentences(sentences, count)] : [], splitMarketingEvenly(Array.from(script), count)];
  let failure: unknown;
  for (const parts of splits) {
    try {
      if (parts.some((text) => speechUnits(text) === 0)) throw new Error("文案过短，请补充内容。");
      if (parts.some((text) => speechUnits(text) > maxShot * MARKETING_MAX_SPEECH_PACE)) throw new Error("部分段落过长，请缩短句子后重试。");
      const durations = allocateShotDurations(parts.map(script => ({ script })), durationSec, maxShot);
      return parts.map((text, index) => ({ index, script: text, durationSec: durations[index] }));
    } catch (error) { failure = error; }
  }
  throw failure;
}

/** Narration edits in the storyboard are also the project's editable copy. */
export const storyboardScript = (shots: Pick<MarketingShot, "script">[]) => shots.map(shot => shot.script.trim()).join("\n");
/** Everything a job renders; publishing fields are not part of the video. */
export function marketingRenderKey(draft: MarketingDraft): string {
  // PG JSONB reorders object keys. Normalize through the schema before comparing.
  const { publishTitle: _title, tags: _tags, ...rest } = MarketingDraftSchema.parse(draft);
  return JSON.stringify(rest);
}
/** What a made video's local composition adds to its clips. Background music always; with
 * twin narration the clips are silent and the voice replaces their audio, and with local
 * subtitles (every job submitted since they apply to all voice modes) the captions are
 * burned in then too. */
export interface MarketingComposition { narration: boolean; localSubtitles: boolean }
/** What a redo keeps from the rendered draft: every setting the clips were made with, the shot
 * count and each shot's duration. Shot text, publishing fields and, given the job's
 * `composition`, the settings only its composition uses may differ. */
export function marketingRevisionKey(draft: MarketingDraft, composition?: MarketingComposition): string {
  const { publishTitle: _title, tags: _tags, script: _script, storyboard, ...rest } = MarketingDraftSchema.parse(draft);
  const durations = storyboard.map(shot => shot.durationSec);
  if (!composition) return JSON.stringify({ ...rest, storyboard: durations });
  const { musicVolume: _volume, subtitles, captions, narration, assets: { music: _music, ...assets }, ...clips } = rest;
  return JSON.stringify({ ...clips, assets, storyboard: durations, ...(composition.localSubtitles ? {} : { subtitles, captions }),
    // The voice mode stays; only the twin voice, pace and tone of a narrated job may change.
    narration: composition.narration && narration ? true : narration });
}
export const marketingShotChanged = (rendered: MarketingShot, shot: MarketingShot | undefined) =>
  !shot || (["script", "visual", "action", "camera"] as const).some(key => rendered[key] !== shot[key]);
/** Whether a changed shot needs a new clip. A narrated job's clip only illustrates its line,
 * so new wording can keep the picture and get a new take and captions instead. */
export const marketingShotNeedsClip = (rendered: MarketingShot, shot: MarketingShot | undefined, composition?: MarketingComposition) =>
  !shot || (["visual", "action", "camera"] as const).some(key => rendered[key] !== shot[key]) || (rendered.script !== shot.script && !composition?.narration);
export const MARKETING_REVIEW_RULE_VERSION = "2026-10-15.1";
export function marketingReviewFields(draft: MarketingDraft): { field: MarketingReviewField; shotIndex?: number; text: string }[] {
  // Worker reservation may read older raw JSONB rows before project() parsing.
  const normalized = MarketingDraftSchema.parse(draft);
  return [
    ...(["script", "publishTitle", "tags", "background"] as const).map(field => ({ field, text: normalized[field] })),
    // Only when present, so drafts without it keep their existing review key.
    ...(normalized.continuity ? [{ field: "continuity" as const, text: normalized.continuity }] : []),
    ...normalized.storyboard.flatMap((shot, shotIndex) => (["script", "visual", "action", "camera"] as const)
      .map(field => ({ field: `storyboard.${field}` as MarketingReviewField, shotIndex, text: shot[field] }))),
  ];
}
export function marketingReviewText(draft: MarketingDraft): string {
  // Field boundaries and shot narration must be part of the review key. The
  // version intentionally invalidates legacy checks that omitted these fields.
  return JSON.stringify({ ruleVersion: MARKETING_REVIEW_RULE_VERSION, fields: marketingReviewFields(draft) });
}

export function marketingReviewFieldText(draft: MarketingDraft, issue: Pick<MarketingReviewIssue, "field" | "shotIndex">): string | null {
  return marketingReviewFields(draft).find(entry => entry.field === issue.field && entry.shotIndex === issue.shotIndex)?.text ?? null;
}

/** Editing a narration field also updates its authoritative counterpart. */
export function updateMarketingReviewField(draft: MarketingDraft, issue: Pick<MarketingReviewIssue, "field" | "shotIndex">, value: string): MarketingDraft | null {
  if (marketingReviewFieldText(draft, issue) === null || !issue.field) return null;
  let next: MarketingDraft;
  if (issue.field.startsWith("storyboard.")) {
    const key = issue.field.slice("storyboard.".length) as "script" | "visual" | "action" | "camera";
    const storyboard = draft.storyboard.map((shot, index) => index === issue.shotIndex ? { ...shot, [key]: value } : shot);
    next = { ...draft, storyboard, ...(key === "script" ? { script: storyboardScript(storyboard) } : {}) };
  } else if (issue.field === "script" && draft.storyboard.length) {
    // Manual copy edits invalidate the old shot boundaries instead of leaving
    // different spoken lines in the render pipeline. The user regenerates them.
    next = { ...draft, script: value, storyboard: [] };
  } else next = { ...draft, [issue.field]: value };
  const parsed = MarketingDraftSchema.safeParse(next);
  return parsed.success ? parsed.data : null;
}

/** Only replace a unique, exact excerpt in its reviewed field; never guess. */
export function applyMarketingReviewSuggestion(draft: MarketingDraft, issue: MarketingReviewIssue): MarketingDraft | null {
  const current = marketingReviewFieldText(draft, issue);
  if (current === null || !issue.text || current.indexOf(issue.text) < 0 || current.indexOf(issue.text) !== current.lastIndexOf(issue.text) || issue.text === issue.suggestion) return null;
  const updated = current.replace(issue.text, () => issue.suggestion);
  if (issue.field === "script" && draft.storyboard.length) {
    if (storyboardScript(draft.storyboard) !== draft.script.trim()) return null;
    const matching = draft.storyboard.map((shot, shotIndex) => ({ shot, shotIndex })).filter(({ shot }) => shot.script.includes(issue.text));
    if (matching.length !== 1) return null;
    const { shot, shotIndex } = matching[0];
    if (shot.script.indexOf(issue.text) !== shot.script.lastIndexOf(issue.text)) return null;
    return updateMarketingReviewField(draft, { field: "storyboard.script", shotIndex }, shot.script.replace(issue.text, () => issue.suggestion));
  }
  return updateMarketingReviewField(draft, issue, updated);
}

/** Saved shot boundaries are authoritative; never re-split edited narration. */
export function resolveMarketingSegments(draft: MarketingDraft, profile: MarketingVideoProfile): MarketingSegment[] {
  const maxShot = marketingShotMaxSeconds(draft, profile);
  if (!draft.storyboard?.length) return planMarketingSegments(draft.script, draft.durationSec, maxShot);
  const durations = draft.storyboard.map(shot => shot.durationSec ?? 15);
  if (maxShot < MARKETING_SHOT_MAX_SECONDS && durations.some(n => n > maxShot)) throw new Error(`当前视频模型每镜最长 ${maxShot} 秒，请重新生成或调整分镜。`);
  if (durations.some(n => !Number.isInteger(n) || n < 4 || n > 15) || !isMarketingDurationValid(draft.durationSec, durations.reduce((a, b) => a + b, 0))) throw new Error("分镜总时长不能短于目标时长，最多可多 5 秒，且不超过 65 秒。");
  if (storyboardScript(draft.storyboard) !== draft.script.trim()) throw new Error("分镜口播与文案不一致，请重新生成分镜。");
  return draft.storyboard.map((shot, index) => {
    if (![shot.script, shot.visual, shot.action, shot.camera].every(value => value.trim())) throw new Error("请补全每段分镜的口播、画面、动作和镜头信息。");
    if (!speechUnits(shot.script)) throw new Error("文案过短，请补充内容。");
    if (speechUnits(shot.script) > durations[index] * MARKETING_MAX_SPEECH_PACE) throw new Error("部分段落过长，请缩短句子后重试。");
    return { index, script: shot.script, durationSec: durations[index] };
  });
}

export * from "./source.js";
export * from "./captions.js";
export * from "./materials.js";
