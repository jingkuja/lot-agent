import { z } from "zod";
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
export type ComicEditCreate = z.infer<typeof comicEditCreateSchema>;
export type ComicEditUpdate = z.infer<typeof comicEditUpdateSchema>;
export type ComicEditReplace = z.infer<typeof comicEditReplaceSchema>;
export type ComicEditAppendSource = z.infer<typeof comicEditAppendSourceSchema>;
export type ComicEditListEntry = { id: string; seriesId: string | null; title: string; revision: number; updatedAt: string };
export type ComicEditSource = {
  takeId: string; mediaId: string; seriesId?: string; seriesTitle: string; clipId: string | null; scene: string; version: number; durationMs: number;
  aspectRatio: ComicTimeline["aspectRatio"]; adopted: { takeId: string; version: number; durationMs: number } | null;
};
export type ComicEditAudioSource = { id: string; durationMs: number };
export type ComicEdit = ComicEditListEntry & { timeline: ComicTimeline; sources: ComicEditSource[]; audioSources: ComicEditAudioSource[] };
export type ComicEditList = { entries: ComicEditListEntry[]; nextCursor: string | null; lastEditId?: string | null };

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
export const comicEditAutoDialogueSchema = z.object({
  expectedRevision: revision,
  includeVoice: z.boolean().default(true),
  includeSubtitles: z.boolean().default(true),
  fallbackPreset: voice.optional(),
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
export type ComicSpeechTake = { mediaId: string; durationMs: number; cached: boolean };
export type ComicAutoDialogueResult = {
  edit: ComicEdit;
  voicedCount: number;
  subtitledCount: number;
  skippedLines: number;
};
