import { z } from "zod";
import { comicClipCastingSchema, type ComicCastChange, type ComicSeriesCast } from "./cast.js";

export const COMIC_DRAMA_ROOT = "/comic-drama";
export const COMIC_DRAMA_API_ROOT = "/api/comic-drama";

const id = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const title = z.string().trim().min(1).max(120);
const dictionaryKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const aspectRatio = z.enum(["9:16", "16:9", "1:1"]);

export const comicDramaCapabilitiesSchema = z.object({
  comicDramaEnabled: z.boolean().default(false),
});

export const comicDramaSeriesFieldsSchema = z.object({
  title,
  logline: z.string().trim().max(2000),
  seriesGroup: title.nullable(),
  episodeNo: z.number().int().min(1).max(2_147_483_647).nullable(),
  styleKey: dictionaryKey,
  aspectRatio,
  // The API must verify the model against the deployment's eligible user catalog.
  videoModel: z.string().trim().min(1).max(128).nullable(),
}).strict();

export const createComicDramaSeriesSchema = comicDramaSeriesFieldsSchema.partial({
  logline: true,
  seriesGroup: true,
  episodeNo: true,
}).strict();

export const updateComicDramaSeriesSchema = comicDramaSeriesFieldsSchema.extend({
  expectedRevision: revision,
}).strict();

export const comicDramaSeriesSchema = comicDramaSeriesFieldsSchema.extend({
  id,
  parentId: id.nullable(),
  revision,
  archivedAt: z.string().datetime().nullable(),
}).strict();

const shot = z.object({
  id,
  framingKey: dictionaryKey,
  movementKey: dictionaryKey,
  description: z.string().trim().max(2000),
  durationShare: z.number().int().min(1).max(100),
}).strict();

const line = z.object({
  id,
  speaker: z.string().trim().min(1).max(120).nullable(),
  text: z.string().trim().max(1000),
  emotionKey: dictionaryKey.nullable(),
  speed: z.number().min(0.5).max(2),
}).strict();

export const comicDramaClipDraftSchema = z.object({
  schemaVersion: z.literal(1),
  // Provider duration restrictions belong to generation validation.
  durationMs: z.number().int().min(1).max(60_000),
  scene: z.string().trim().max(1000),
  shots: z.array(shot).max(3),
  lines: z.array(line).max(30),
  cast: comicClipCastingSchema.optional(),
}).strict().superRefine(({ shots, lines }, ctx) => {
  if (shots.length && shots.reduce((total, entry) => total + entry.durationShare, 0) !== 100) {
    ctx.addIssue({ code: "custom", path: ["shots"], message: "Shot duration shares must total 100" });
  }
  for (const [field, entries] of [["shots", shots], ["lines", lines]] as const) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
      ctx.addIssue({ code: "custom", path: [field], message: "Entry IDs must be unique" });
    }
  }
});

export const comicDramaClipSchema = z.object({
  id,
  revision,
  ordinal: z.number().int().positive(),
  draft: comicDramaClipDraftSchema,
}).strict();

export const updateComicDramaClipSchema = z.object({
  expectedRevision: revision,
  draft: comicDramaClipDraftSchema,
}).strict();

export const reorderComicDramaClipsSchema = z.object({
  expectedRevision: revision,
  clipIds: z.array(id).refine(ids => new Set(ids).size === ids.length, "Clip IDs must be unique"),
}).strict();

export const comicDramaRevisionConflictSchema = z.object({
  code: z.literal("REVISION_CONFLICT"),
  currentRevision: revision,
}).strict();

export type ComicDramaSeries = z.infer<typeof comicDramaSeriesSchema>;
export type ComicDramaClip = z.infer<typeof comicDramaClipSchema>;


export const comicDramaIdSchema = id;
export const comicDramaSetCurrentSchema = z.object({ seriesId: id }).strict();
export const comicDramaRevisionSchema = z.object({ expectedRevision: revision }).strict();
export const comicDramaScriptWriteSchema = comicDramaRevisionSchema.extend({
  content: z.string().max(20_000),
}).strict();
export const comicDramaSeriesListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  archived: z.enum(["true", "false"]).default("false"),
  cursor: z.string().max(80).optional(),
}).strict();

export type ComicDramaSeriesInput = z.infer<typeof createComicDramaSeriesSchema>;
export type ComicDramaSeriesUpdate = z.infer<typeof updateComicDramaSeriesSchema>;
export type ComicDramaClipDraft = z.infer<typeof comicDramaClipDraftSchema>;
export type ComicDramaClipUpdate = z.infer<typeof updateComicDramaClipSchema>;
export type ComicDramaReorder = z.infer<typeof reorderComicDramaClipsSchema>;
export type ComicDramaListQuery = z.infer<typeof comicDramaSeriesListSchema>;

export type ComicDramaScript = { version: number; content: string };
export type ComicDramaDetail = { series: ComicDramaSeries; clips: ComicDramaClip[]; script: ComicDramaScript | null; cast: ComicSeriesCast[] };
export type ComicDramaListing = {
  entries: Array<ComicDramaSeries & { updatedAt: string; clipCount: number; hasRender: boolean }>;
  nextCursor: string | null;
};
export type ComicDramaContent = Pick<ComicDramaDetail, "clips" | "script" | "cast"> & { seriesRevision: number };

export interface ComicDramaRepository {
  list(owner: string, query: ComicDramaListQuery): Promise<ComicDramaListing>;
  get(owner: string, seriesId: string): Promise<ComicDramaDetail>;
  current(owner: string): Promise<string | null>;
  open(owner: string, seriesId: string): Promise<ComicDramaDetail>;
  create(owner: string, fields: ComicDramaSeriesInput): Promise<ComicDramaDetail>;
  derive(owner: string, seriesId: string, sequel: boolean, inheritCastAndStyle?: boolean): Promise<ComicDramaDetail>;
  readCast(owner: string, seriesId: string): Promise<{ cast: ComicSeriesCast[]; seriesRevision: number }>;
  changeCast(owner: string, seriesId: string, expectedRevision: number, change: ComicCastChange): Promise<ComicDramaContent>;
  update(owner: string, seriesId: string, fields: ComicDramaSeriesUpdate): Promise<ComicDramaSeries>;
  archive(owner: string, seriesId: string, expectedRevision: number): Promise<void>;
  remove(owner: string, seriesId: string, expectedRevision: number): Promise<void>;
  saveScript(owner: string, seriesId: string, expectedRevision: number, content: string): Promise<ComicDramaContent>;
  addClip(owner: string, seriesId: string, expectedRevision: number): Promise<ComicDramaContent>;
  saveClip(owner: string, seriesId: string, clipId: string, input: ComicDramaClipUpdate): Promise<{ clip: ComicDramaClip; seriesRevision: number }>;
  copyClip(owner: string, seriesId: string, clipId: string, expectedRevision: number): Promise<ComicDramaContent>;
  removeClip(owner: string, seriesId: string, clipId: string, expectedRevision: number): Promise<ComicDramaContent>;
  reorder(owner: string, seriesId: string, input: ComicDramaReorder): Promise<ComicDramaContent>;
}

export * from "./library.js";
export * from "./cast.js";
export * from "./generation.js";
export * from "./timeline.js";
export * from "./edit.js";
export * from "./director.js";
