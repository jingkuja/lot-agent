import { z } from "zod";
import { comicCharacterInput } from "./library.js";

export const COMIC_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024;
export const COMIC_VOICE_PROMPT_MAX = 500;
export const comicVoicePreviewSampleRates = [16000, 24000, 48000] as const;
export const comicVoicePreviewFormats = ["wav", "mp3"] as const;
export const comicLibraryVoiceIdSchema = z.string().uuid().transform(value => value.toLowerCase());
const entry = z.object({ id: comicLibraryVoiceIdSchema, name: z.string().trim().min(1).max(120) });
const text = (min: number, max: number) => z.string().trim().min(min).max(max)
  .regex(/^[\p{Script=Han}A-Za-z\p{N}\p{P}\p{Zs}\s]+$/u);

export const comicLibraryVoiceCreateSchema = z.discriminatedUnion("kind", [
  entry.extend({
    kind: z.literal("design"), voicePrompt: text(1, COMIC_VOICE_PROMPT_MAX), previewText: text(15, 200), language: z.enum(["zh", "en"]),
    sampleRate: z.union([z.literal(16000), z.literal(24000), z.literal(48000)]).optional(),
    previewFormat: z.enum(comicVoicePreviewFormats).optional(),
  }).strict(),
  entry.extend({ kind: z.literal("clone"), ownVoice: z.literal(true) }).strict(),
]).refine(input => input.kind === "clone" || (input.language === "zh" ? /\p{Script=Han}/u.test(input.previewText)
  : /[A-Za-z]/.test(input.previewText) && !/\p{Script=Han}/u.test(input.previewText)), { path: ["previewText"] });

export const comicLibraryVoiceListSchema = z.object({
  query: z.string().trim().max(120).default(""),
  archived: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
}).strict();
export const comicLibraryVoiceArchiveSchema = z.object({ archived: z.boolean() }).strict();

export const comicCharacterVoiceDesignInput = z.object({
  id: comicLibraryVoiceIdSchema,
  language: z.enum(["zh", "en"]),
  character: comicCharacterInput.pick({ name: true, gender: true, age: true, personality: true, appearance: true, roleKey: true, tags: true }),
}).strict();

export const comicCharacterVoiceDesignOutput = z.object({
  pitch: text(1, 40),
  pace: text(1, 40),
  timbre: text(1, 100),
  delivery: text(1, 160),
  previewText: text(15, 200),
}).strict();

export type ComicLibraryVoiceCreate = z.infer<typeof comicLibraryVoiceCreateSchema>;
export type ComicLibraryVoice = {
  id: string;
  name: string;
  kind: ComicLibraryVoiceCreate["kind"];
  voicePrompt: string | null;
  previewText: string | null;
  previewMediaId: string | null;
  status: "unknown" | "DEPLOYING" | "OK" | "UNDEPLOYED" | "failed";
  archived: boolean;
};
export type ComicLibraryVoiceList = { entries: ComicLibraryVoice[]; more: boolean; enabled: boolean };
export type ComicLibraryVoiceChoices = { entries: Pick<ComicLibraryVoice, "id" | "name" | "kind">[]; enabled: boolean };
export type ComicCharacterVoiceDesignInput = z.infer<typeof comicCharacterVoiceDesignInput>;
export type ComicCharacterDesignVoice = Pick<ComicLibraryVoice, "id" | "name" | "status" | "previewMediaId"> & { voiceId: string | null };
