import { z } from "zod";
import { KLING_MARKETING_PROFILE, MARKETING_MAX_SECTION_IMAGES, marketingVideoProfile, type MarketingVideoProfile } from "./models.js";

export * from "./models.js";

export const MARKETING_COPY_MODEL = "kimi-k3";
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
export const MarketingDraftSchema = z.preprocess(withoutLegacyCover, z.object({
  topic: z.string().max(800).default(""),
  copyMode: z.enum(["generate", "rewrite"]).default("generate"),
  reference: z.string().max(6000).default(""),
  referenceUpload: z.object({ id: z.string().uuid(), name: z.string().min(1).max(255) }).strict().optional(),
  script: z.string().max(2000).default(""),
  durationSec: z.number().int().min(15).max(60).default(30),
  // Only digital-presenter videos exist; drafts may still hold the never-offered "recorded".
  mode: z.literal("avatar").catch("avatar"),
  // "always": presenter in every shot. "mixed": presenter in some shots; others may
  // show the venue, dishes or product close-ups (store tours).
  presenter: z.enum(["always", "mixed"]).default("always"),
  background: z.string().max(600).default("简约演播室"),
  voice: z.string().max(100).default("自然旁白"),
  ratio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  quality: z.enum(["720p", "1080p"]).default("720p"),
  subtitles: z.boolean().default(true),
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
  continuity: z.string().max(400).default(""),
  /** Whether the board was planned for native speech (no reference video). Absent on
   * boards planned before this was recorded. */
  storyboardAudio: z.boolean().optional(),
  narration: MarketingNarrationSchema.optional(),
  publishTitle: z.string().max(100).default(""),
  tags: z.string().max(160).default(""),
}).strict());
export type MarketingDraft = z.infer<typeof MarketingDraftSchema>;
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

const MARKETING_IMAGE_SECTION_NAMES: Record<MarketingImageSection, string> = { portrait: "人物", product: "产品", setting: "场景" };
/** Section or total image limit of the model that `assets` exceed. */
export function marketingImageLimitError(assets: Partial<Record<MarketingImageSlot, string | string[]>>, profile: MarketingVideoProfile): string {
  for (const section of ["portrait", "product", "setting"] as const) {
    const limit = profile.referenceImages[section];
    if (marketingImageCount(assets, section) > limit) return `当前视频模型的${MARKETING_IMAGE_SECTION_NAMES[section]}图片最多 ${limit} 张，请移除多余图片。`;
  }
  return marketingImageCount(assets) > profile.referenceImages.total ? `当前视频模型的参考图片合计最多 ${profile.referenceImages.total} 张，请移除多余图片。` : "";
}
/** Reference combinations the model cannot use. */
export function marketingReferenceError(draft: MarketingDraft, profile: MarketingVideoProfile): string {
  const images = marketingImageCount(draft.assets);
  if (draft.assets.video && images > profile.imagesWithReferenceVideo) {
    return profile.imagesWithReferenceVideo
      ? `已选择参考视频，参考图片合计不能超过 ${profile.imagesWithReferenceVideo} 张，请移除多余图片。`
      : "已选择参考视频，参考图片不会参与生成，请移除图片或参考视频。";
  }
  const limitError = marketingImageLimitError(draft.assets, profile);
  if (limitError) return limitError;
  if (profile.referenceMaxQuality === "720p" && draft.quality === "1080p" && (images || draft.assets.video)) return "使用参考图片或参考视频时最高支持 720p，请将视频质量改为默认。";
  return "";
}
export const MarketingReviewFieldSchema = z.enum(["script", "publishTitle", "tags", "background", "continuity", "storyboard.script", "storyboard.visual", "storyboard.action", "storyboard.camera"]);
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
  error?: string; errorCode?: MarketingFailureCode; output?: { assetIds: string[]; assets: { url: string; mime: string }[] };
  knowledgeItemId: string | null;
  knowledgeVersion?: number | null;
  /** Clips of the current job whose paid submission outcome is unknown. */
  unknownSegments?: number;
  /** Set when single shots of the current stopped or finished job can be redone: the
   * draft it rendered, its clip model, which of its clips can be kept unpaid, and what its
   * local composition adds to them. */
  revision?: { draft: MarketingDraft; modelId: string; reusable: boolean[]; composition: MarketingComposition };
}
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
 * `floor` raises single shots' minimums, e.g. to fit measured narration. */
export function allocateShotDurations(shots: { script: string; durationSec?: number }[], target: number, maxShot = MARKETING_SHOT_MAX_SECONDS, floor: (number | undefined)[] = []): number[] {
  const maximum = marketingMaxDuration(target);
  if (!isMarketingDurationValid(target, target) || !shots.length || shots.length > 15
    || shots.length * 4 > maximum || shots.length * maxShot < target) throw new Error("分镜数量与视频时长不一致，请重新生成分镜。");
  const minimum = shots.map((shot, i) => Math.max(4, Math.ceil(speechUnits(shot.script) / 4.5), floor[i] ?? 0));
  const minimumTotal = minimum.reduce((a, b) => a + b, 0);
  if (minimum.some(n => n > maxShot) || minimumTotal > maximum) throw new Error("文案过长，请精简文案或增加视频时长。");
  const requested = shots.map(shot => shot.durationSec ?? 0);
  if (requested.every((n, i) => Number.isInteger(n) && n >= minimum[i] && n <= maxShot) && isMarketingDurationValid(target, requested.reduce((a, b) => a + b, 0))) return requested;
  const total = Math.max(target, minimumTotal);
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
/** Lengthen shots whose measured narration does not fit, within the draft's duration range.
 * Shots that already fit keep their time when the total allows it. */
export function fitMarketingNarration(shots: MarketingShot[], draft: Pick<MarketingDraft, "assets" | "durationSec">, profile: MarketingVideoProfile, durationsMs: (number | undefined)[]): MarketingShot[] {
  const maxShot = marketingShotMaxSeconds(draft, profile);
  const floor = durationsMs.map(ms => ms === undefined ? undefined : marketingNarrationShotMinimum(ms));
  if (floor.some(n => n !== undefined && n > maxShot)) throw new Error(`有分镜的配音超过 ${maxShot} 秒，请精简该镜口播或调快语速。`);
  let durations: number[];
  try { durations = allocateShotDurations(shots, draft.durationSec, maxShot, floor); }
  catch { throw new Error("配音总时长超过视频时长上限，请精简文案、调快语速或增加视频时长。"); }
  return shots.map((shot, index) => ({ ...shot, durationSec: durations[index] }));
}
/** One shot's narration state as the studio shows it. */
export interface MarketingNarrationClip {
  slot: number;
  /** missing: not synthesized for the current text and voice settings. */
  status: "missing" | "running" | "succeeded" | "failed";
  durationMs?: number;
}

/** Re-time saved shots that exceed the draft's cap, e.g. after a reference video is added. */
export function capMarketingStoryboard(shots: MarketingShot[], draft: Pick<MarketingDraft, "assets" | "durationSec">, profile: MarketingVideoProfile): MarketingShot[] {
  const maxShot = marketingShotMaxSeconds(draft, profile);
  if (!shots.some(shot => (shot.durationSec ?? MARKETING_SHOT_MAX_SECONDS) > maxShot)) return shots;
  try { return timeMarketingStoryboard(shots, draft.durationSec, maxShot); }
  catch { throw new Error(`当前视频模型每镜最长 ${maxShot} 秒，请重新生成全部分镜。`); }
}

/** Split at phrase boundaries. Segment times are integers accepted by the video model. */
export function planMarketingSegments(script: string, durationSec: number, maxShot = MARKETING_SHOT_MAX_SECONDS): MarketingSegment[] {
  if (!Number.isInteger(durationSec) || durationSec < 15 || durationSec > 60 || !script.trim()) throw new Error("请填写文案并选择 15–60 秒的整片时长。");
  const units = speechUnits(script);
  if (units > marketingMaxDuration(durationSec) * 4.5) throw new Error("文案过长，请精简文案或增加视频时长。");
  // Preserve every character, including whitespace and punctuation. Long
  // sentences may be split at a comma, space, or ultimately a character edge.
  const count = Math.max(Math.ceil(durationSec / maxShot), Math.min(Math.ceil(durationSec / 8), Math.floor(units / 4)));
  if (units < count * 4) throw new Error("文案过短，请补充内容。");
  const chars = Array.from(script.trim());
  if (chars.length < count) throw new Error("文案过短，请补充内容。");
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const remaining = chars.length - start;
    const target = start + Math.round(remaining / (count - i));
    const lower = start + Math.max(1, Math.floor(remaining / (count - i) * 0.65));
    const upper = Math.min(chars.length - (count - i - 1), start + Math.ceil(remaining / (count - i) * 1.2));
    let end = target;
    const candidates = Array.from({ length: upper - lower + 1 }, (_, n) => lower + n)
      .filter((n) => /[。！？.!?；;，,\s]/u.test(chars[n - 1]));
    if (candidates.length) end = candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    parts.push(chars.slice(start, end).join("")); start = end;
  }
  parts.push(chars.slice(start).join(""));
  if (parts.some((text) => speechUnits(text) === 0)) throw new Error("文案过短，请补充内容。");
  if (parts.some((text) => speechUnits(text) > maxShot * 4.5)) throw new Error("部分段落过长，请缩短句子后重试。");
  const durations = allocateShotDurations(parts.map(script => ({ script })), durationSec, maxShot);
  return parts.map((text, index) => ({ index, script: text, durationSec: durations[index] }));
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
 * subtitles the captions are burned in then too. */
export interface MarketingComposition { narration: boolean; localSubtitles: boolean }
/** What a redo keeps from the rendered draft: every setting the clips were made with, the shot
 * count and each shot's duration. Shot text, publishing fields and, given the job's
 * `composition`, the settings only its composition uses may differ. */
export function marketingRevisionKey(draft: MarketingDraft, composition?: MarketingComposition): string {
  const { publishTitle: _title, tags: _tags, script: _script, storyboard, ...rest } = MarketingDraftSchema.parse(draft);
  const durations = storyboard.map(shot => shot.durationSec);
  if (!composition) return JSON.stringify({ ...rest, storyboard: durations });
  const { musicVolume: _volume, subtitles, narration, assets: { music: _music, ...assets }, ...clips } = rest;
  return JSON.stringify({ ...clips, assets, storyboard: durations, ...(composition.localSubtitles ? {} : { subtitles }),
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
    if (speechUnits(shot.script) > durations[index] * 4.5) throw new Error("部分段落过长，请缩短句子后重试。");
    return { index, script: shot.script, durationSec: durations[index] };
  });
}

export * from "./source.js";
