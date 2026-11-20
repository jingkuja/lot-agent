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
export const comicEditDeleteSchema = z.object({ expectedRevision: revision }).strict();
export const comicEditListSchema = z.object({ cursor: z.string().max(100).optional() }).strict();
export type ComicEditCreate = z.infer<typeof comicEditCreateSchema>;
export type ComicEditUpdate = z.infer<typeof comicEditUpdateSchema>;
export type ComicEditReplace = z.infer<typeof comicEditReplaceSchema>;
export type ComicEditListEntry = { id: string; seriesId: string | null; title: string; revision: number; updatedAt: string };
export type ComicEditSource = {
  takeId: string; mediaId: string; seriesTitle: string; clipId: string | null; scene: string; version: number; durationMs: number;
  aspectRatio: ComicTimeline["aspectRatio"]; adopted: { takeId: string; version: number; durationMs: number } | null;
};
export type ComicEditAudioSource = { id: string; durationMs: number };
export type ComicEdit = ComicEditListEntry & { timeline: ComicTimeline; sources: ComicEditSource[]; audioSources: ComicEditAudioSource[] };
export type ComicEditList = { entries: ComicEditListEntry[]; nextCursor: string | null };

export function emptyComicTimeline(aspectRatio: ComicTimeline["aspectRatio"]): ComicTimeline {
  return { schemaVersion: 1, aspectRatio, video: [], voice: [], sfx: [], music: [], subtitles: [] };
}

export function comicVideoItem(id: string, source: Pick<ComicEditSource, "takeId" | "durationMs">): ComicTimeline["video"][number] {
  return { id, takeId: source.takeId, sourceDurationMs: source.durationMs, inMs: 0, outMs: source.durationMs,
    volume: 1, transitionIn: { kind: "cut", durationMs: 0 } };
}

export const comicSpeechPresets = ["alloy", "nova", "onyx"] as const;
const voice = z.enum(comicSpeechPresets);
export const comicVoiceBindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("preset"), preset: voice }).strict(),
  z.object({ kind: z.literal("clone"), itemId: id, authorized: z.literal(true) }).strict(),
]);
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
export type ComicSpeechRequest = z.infer<typeof comicSpeechRequestSchema>;
export type ComicSpeechRelease = z.infer<typeof comicSpeechReleaseSchema>;
export type ComicVoiceSettings = { binding: ComicVoiceBind; presets: readonly string[]; clonesEnabled: boolean; clones: { id: string; title: string }[] };
export type ComicSpeechLines = {
  clipRevision: number | null;
  presets: readonly string[];
  lines: { id: string; text: string; speaker: string | null; speed: number; emotionKey: string | null }[];
  characters: { id: string; name: string; aliases: string[] }[];
};
export type ComicSpeechTake = { mediaId: string; durationMs: number; cached: boolean };
