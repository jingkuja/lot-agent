import { z } from "zod";
import type { ComicVideoAudioMode } from "./models.js";
import { comicTimelineSchema, type ComicTimeline } from "./timeline.js";

const id = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const title = z.string().trim().min(1).max(120);
const aspect = z.enum(["9:16", "16:9", "1:1"]);

export const comicEditCreateSchema = z.object({ title, seriesId: id.optional(), takeId: id.optional(), aspectRatio: aspect.optional() }).strict();
export const comicEditUpdateSchema = z.object({
  title, expectedRevision: revision,
  timeline: comicTimelineSchema.refine(t => t.video.length <= 200 && t.voice.length + t.sfx.length + t.music.length + t.subtitles.length <= 1200),
}).strict();
export const comicEditReplaceSchema = z.object({
  expectedRevision: revision, takeId: id, outMs: z.number().int().positive().optional(),
}).strict();
export const comicEditAppendSourceSchema = z.object({
  expectedRevision: revision, takeId: id,
}).strict();
export const comicEditDeleteSchema = z.object({ expectedRevision: revision }).strict();
export const comicEditListSchema = z.object({ cursor: z.string().max(100).optional() }).strict();
export const comicDramaEditOpenSchema = z.object({ seriesId: id.optional() }).strict();
export const comicDramaEditSyncSchema = z.object({ expectedRevision: revision }).strict();
export type ComicEditCreate = z.infer<typeof comicEditCreateSchema>;
export type ComicEditUpdate = z.infer<typeof comicEditUpdateSchema>;
export type ComicEditReplace = z.infer<typeof comicEditReplaceSchema>;
export type ComicEditAppendSource = z.infer<typeof comicEditAppendSourceSchema>;
export type ComicDramaEditOpen = z.infer<typeof comicDramaEditOpenSchema>;
export type ComicDramaEditSync = z.infer<typeof comicDramaEditSyncSchema>;
export type ComicEditTaskKind = "drama" | "free";
export type ComicDramaEditEpisodeItem = {
  seriesId: string;
  episodeNo: number;
  title: string;
  logline: string;
  aspectRatio: ComicTimeline["aspectRatio"];
  archivedAt: string | null;
  clipCount: number;
  adoptedClipCount: number;
  editId: string | null;
  editRevision: number | null;
  timelineClipCount: number;
  timelineDurationMs: number;
  unaddedAdoptedCount: number;
  outdatedAdoptedCount: number;
  renderCount: number;
  hasReadyRender: boolean;
  updatedAt: string;
};
export type ComicDramaEditTaskSummary = {
  id: string;
  dramaId: string;
  dramaTitle: string;
  synopsis: string;
  styleKey: string;
  aspectRatio: ComicTimeline["aspectRatio"];
  archivedAt: string | null;
  lastSeriesId: string | null;
  updatedAt: string;
};
export type ComicDramaEditTaskEntry = ComicDramaEditTaskSummary & {
  lastEpisodeNo: number | null;
  lastEpisodeTitle: string | null;
  episodeCount: number;
  editedEpisodeCount: number;
  exportedEpisodeCount: number;
  coverMediaId: string | null;
  episodes: ComicDramaEditEpisodeItem[];
};
export type ComicEditLastSummary = {
  id: string;
  title: string;
  taskKind: ComicEditTaskKind;
  dramaId: string | null;
  dramaTitle: string | null;
  seriesId: string | null;
  episodeNo: number | null;
  episodeTitle: string | null;
};
export type ComicEditUnaddedTake = {
  clipId: string;
  ordinal: number;
  scene: string;
  takeId: string;
  durationMs: number;
};
export type ComicEditListEntry = {
  id: string;
  seriesId: string | null;
  dramaId?: string | null;
  dramaTitle?: string | null;
  episodeNo?: number | null;
  episodeTitle?: string | null;
  taskKind?: ComicEditTaskKind;
  title: string;
  revision: number;
  updatedAt: string;
};
export type ComicEditSource = {
  takeId: string; mediaId: string;
  dramaId?: string; dramaTitle?: string; episodeNo?: number | null; clipOrdinal?: number | null;
  seriesId?: string; seriesTitle: string; clipId: string | null; scene: string; version: number; durationMs: number;
  aspectRatio: ComicTimeline["aspectRatio"]; adopted: { takeId: string; version: number; durationMs: number } | null;
  audioMode?: ComicVideoAudioMode;
};
export type ComicEditAudioSource = { id: string; durationMs: number };
export type ComicEdit = ComicEditListEntry & {
  dramaEditTaskId?: string | null;
  dramaArchivedAt?: string | null;
  dramaEpisodes?: ComicDramaEditEpisodeItem[];
  unaddedAdoptedTakes?: ComicEditUnaddedTake[];
  timeline: ComicTimeline;
  sources: ComicEditSource[];
  audioSources: ComicEditAudioSource[];
};
export type ComicDramaEditTaskView = {
  task: ComicDramaEditTaskSummary;
  episodes: ComicDramaEditEpisodeItem[];
  activeSeriesId: string | null;
  edit: ComicEdit | null;
};
export type ComicEditList = {
  entries: ComicEditListEntry[];
  dramaTasks?: ComicDramaEditTaskEntry[];
  nextCursor: string | null;
  lastEditId?: string | null;
  lastEdit?: ComicEditLastSummary | null;
};

export function emptyComicTimeline(aspectRatio: ComicTimeline["aspectRatio"]): ComicTimeline {
  return { schemaVersion: 1, aspectRatio, video: [], voice: [], sfx: [], music: [], subtitles: [] };
}

export function comicVideoItem(id: string, source: Pick<ComicEditSource, "takeId" | "durationMs">): ComicTimeline["video"][number] {
  return { id, takeId: source.takeId, sourceDurationMs: source.durationMs, inMs: 0, outMs: source.durationMs,
    volume: 1, transitionIn: { kind: "cut", durationMs: 0 } };
}

export const comicSpeechPresets = ["alloy", "nova", "onyx"] as const;
export type ComicSpeechPresetId = (typeof comicSpeechPresets)[number];
export type ComicSpeechPresetMeta = {
  id: ComicSpeechPresetId;
  gender: "neutral" | "female" | "male";
  age: "young_adult" | "adult" | "mature";
  tone: "balanced" | "bright" | "deep";
  labels: { zh: string; en: string; id: string };
  summary: { zh: string; en: string; id: string };
};
export const COMIC_SPEECH_PRESET_CATALOG: readonly ComicSpeechPresetMeta[] = [
  {
    id: "alloy", gender: "neutral", age: "young_adult", tone: "balanced",
    labels: { zh: "清朗中性 · 青年", en: "Clear Neutral · Young Adult", id: "Netral Jernih · Dewasa Muda" },
    summary: { zh: "咬字自然平稳，适合旁白或冷静主角", en: "Balanced and clear, ideal for narration or calm leads", id: "Seimbang dan jelas, cocok untuk narasi" },
  },
  {
    id: "nova", gender: "female", age: "young_adult", tone: "bright",
    labels: { zh: "明快女声 · 少女/青年", en: "Bright Female · Youthful", id: "Wanita Cerah · Muda" },
    summary: { zh: "清脆有活力，适合女主与轻快对话", en: "Lively and expressive, suited for female leads", id: "Ceria dan ekspresif, cocok untuk tokoh wanita" },
  },
  {
    id: "onyx", gender: "male", age: "mature", tone: "deep",
    labels: { zh: "沉稳男声 · 成熟", en: "Deep Male · Mature", id: "Pria Berat · Dewasa" },
    summary: { zh: "低沉有磁性，适合男主、反派或悬疑旁白", en: "Deep and resonant, suited for male leads or suspense", id: "Dalam dan berwibawa, cocok untuk tokoh pria" },
  },
];
const voice = z.enum(comicSpeechPresets);
const emotionKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const comicVoiceBindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("preset"), preset: voice }).strict(),
  z.object({ kind: z.literal("clone"), itemId: id, authorized: z.literal(true) }).strict(),
]);
export const comicVoiceAuditionSchema = z.object({
  text: z.string().trim().min(1).max(300),
  speed: z.number().min(0.5).max(2).default(1),
  emotionKey: emotionKey.nullable().optional(),
  voice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), preset: voice }).strict(),
    z.object({ kind: z.literal("clone"), itemId: id }).strict(),
    z.object({ kind: z.literal("character"), characterId: id }).strict(),
  ]),
}).strict();
export const comicVoiceAuditionReleaseSchema = comicVoiceAuditionSchema.extend({
  acknowledgePossibleCharge: z.literal(true),
}).strict();
export const comicEditAutoDialogueOverrideSchema = z.object({
  videoItemId: id,
  lineId: id,
  text: z.string().trim().min(1).max(1000).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  overflowAction: z.enum(["trim", "skip"]).optional(),
}).strict();
export const comicEditAutoDialoguePreviewSchema = z.object({
  expectedRevision: revision,
  includeVoice: z.boolean().default(true),
  includeSubtitles: z.boolean().default(true),
  fallbackPreset: voice.optional(),
  overrides: z.array(comicEditAutoDialogueOverrideSchema).max(300).optional(),
  replaceNativeAudioVideoItemIds: z.array(id).max(200).optional(),
}).strict();
export const comicEditAutoDialogueSchema = comicEditAutoDialoguePreviewSchema.extend({
  overflowMode: z.enum(["ask", "trim"]).default("ask"),
}).strict();
export const comicSpeechRequestSchema = z.object({
  expectedRevision: revision, expectedClipRevision: revision,
  voice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), preset: voice }).strict(),
    z.object({ kind: z.literal("character"), characterId: id }).strict(),
  ]),
}).strict();
export const comicSpeechReleaseSchema = comicSpeechRequestSchema.extend({
  acknowledgePossibleCharge: z.literal(true),
}).strict();
export type ComicVoiceBind = z.infer<typeof comicVoiceBindSchema>;
export type ComicVoiceAudition = z.infer<typeof comicVoiceAuditionSchema>;
export type ComicVoiceAuditionRelease = z.infer<typeof comicVoiceAuditionReleaseSchema>;
export type ComicEditAutoDialogueOverride = z.infer<typeof comicEditAutoDialogueOverrideSchema>;
export type ComicEditAutoDialoguePreview = z.infer<typeof comicEditAutoDialoguePreviewSchema>;
export type ComicEditAutoDialogue = z.infer<typeof comicEditAutoDialogueSchema>;
export type ComicSpeechRequest = z.infer<typeof comicSpeechRequestSchema>;
export type ComicSpeechRelease = z.infer<typeof comicSpeechReleaseSchema>;
export type ComicVoiceSettings = {
  binding: ComicVoiceBind;
  presets: readonly string[];
  presetCatalog?: readonly ComicSpeechPresetMeta[];
  clonesEnabled: boolean;
  clones: { id: string; title: string }[];
};
export type ComicSpeechLines = {
  clipRevision: number | null;
  presets: readonly string[];
  presetCatalog?: readonly ComicSpeechPresetMeta[];
  lines: { id: string; text: string; speaker: string | null; speed: number; emotionKey: string | null }[];
  characters: { id: string; name: string; aliases: string[] }[];
};
export type ComicSpeechTake = { mediaId: string; durationMs: number; cached: boolean; attemptId?: string };
export type ComicAutoDialoguePlanLine = {
  videoItemId: string;
  clipId: string | null;
  lineId: string;
  speaker: string | null;
  text: string;
  speed: number;
  audioMode?: ComicVideoAudioMode;
  status: "already_placed" | "cached" | "to_synthesize" | "unknown_blocked" | "no_voice"
    | "compliance_blocked" | "no_room" | "native_audio_subtitle_only";
  remainingMs: number;
  cachedDurationMs?: number;
  overflowMs?: number;
  suggestedSpeed?: number;
  errorCode?: string;
};
export const COMIC_SPEECH_ESTIMATE_POINTS = 100;

export type ComicAutoDialogueNativeClip = {
  videoItemId: string;
  scene: string;
  audioMode: Exclude<ComicVideoAudioMode, "silent_tts">;
  lineCount: number;
  replaceWithTts: boolean;
};

export type ComicAutoDialoguePlan = {
  totalLines: number;
  alreadyPlacedCount: number;
  cachedCount: number;
  toSynthesizeCount: number;
  blockedCount: number;
  skippedCount: number;
  overflowCount: number;
  nativeAudioSkippedCount?: number;
  nativeAudioClips?: ComicAutoDialogueNativeClip[];
  feeStatus: "free_cached" | "fixed_points";
  estimatedPoints: number;
  lines: ComicAutoDialoguePlanLine[];
};
export type ComicAutoDialogueItemOutcome = {
  videoItemId: string;
  clipId: string | null;
  lineId: string;
  speaker: string | null;
  text: string;
  speed: number;
  audioMode?: ComicVideoAudioMode;
  status: "applied" | "trimmed" | "overflow" | "failed" | "skipped" | "subtitle_only";
  cached: boolean;
  audioDurationMs?: number;
  remainingMs?: number;
  suggestedSpeed?: number;
  errorCode?: string;
};
export type ComicAutoDialogueResult = {
  edit: ComicEdit;
  voicedCount: number;
  subtitledCount: number;
  cachedCount: number;
  synthesizedCount: number;
  skippedLines: number;
  overflowCount: number;
  failedCount: number;
  nativeAudioSkippedCount?: number;
  mutedVideoItemIds?: string[];
  items: ComicAutoDialogueItemOutcome[];
};
