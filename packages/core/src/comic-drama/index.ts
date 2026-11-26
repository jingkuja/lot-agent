import { z } from "zod";
import { comicVideoAudioModes, comicVideoResolutions } from "./models.js";
import { comicClipCastingSchema, type ComicCastChange, type ComicSeriesCast } from "./cast.js";

export const COMIC_DRAMA_ROOT = "/comic-drama";
export const COMIC_DRAMA_API_ROOT = "/api/comic-drama";
export const COMIC_DRAMA_OUTLINE_MAX_CHARS = 20_000;
export const COMIC_DRAMA_SCRIPT_MAX_CHARS = 50_000;

const id = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const title = z.string().trim().min(1).max(120);
const dictionaryKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const aspectRatio = z.enum(["9:16", "16:9", "1:1"]);

export const comicDramaCapabilitiesSchema = z.object({
  comicDramaEnabled: z.boolean().default(false),
});

export const comicDramaFieldsSchema = z.object({
  title,
  synopsis: z.string().trim().max(2000),
  styleKey: dictionaryKey,
  aspectRatio,
  videoModel: z.string().trim().min(1).max(128).nullable(),
}).strict();

export const createComicDramaSchema = comicDramaFieldsSchema.partial({
  synopsis: true,
  videoModel: true,
}).extend({
  outline: z.string().max(COMIC_DRAMA_OUTLINE_MAX_CHARS).optional(),
  scriptContent: z.string().max(COMIC_DRAMA_SCRIPT_MAX_CHARS).optional(),
  firstEpisodeTitle: title.optional(),
  firstEpisodeLogline: z.string().trim().max(2000).optional(),
  createFirstEpisode: z.boolean().optional(),
}).strict();

export const updateComicDramaSchema = comicDramaFieldsSchema.extend({
  outline: z.string().max(COMIC_DRAMA_OUTLINE_MAX_CHARS).optional(),
  scriptContent: z.string().max(COMIC_DRAMA_SCRIPT_MAX_CHARS).optional(),
  expectedRevision: revision,
}).strict();

export const comicDramaOutlineWriteSchema = z.object({
  expectedRevision: revision,
  outline: z.string().max(COMIC_DRAMA_OUTLINE_MAX_CHARS),
}).strict();

export const comicDramaMasterScriptWriteSchema = z.object({
  expectedRevision: revision,
  content: z.string().max(COMIC_DRAMA_SCRIPT_MAX_CHARS),
}).strict();

export const comicDramaOutlinePolishSchema = z.object({
  outline: z.string().trim().min(1).max(COMIC_DRAMA_OUTLINE_MAX_CHARS).refine(v => !v.includes("\0")),
  instruction: z.string().trim().max(1000).refine(v => !v.includes("\0")).optional(),
  language: z.enum(["zh", "en", "id"]).default("zh"),
}).strict();

export const comicDramaScriptGenerateSchema = z.object({
  episodeCount: z.number().int().min(1).max(50),
  notes: z.string().trim().max(4000).refine(v => !v.includes("\0")).optional().default(""),
  outline: z.string().max(COMIC_DRAMA_OUTLINE_MAX_CHARS).refine(v => !v.includes("\0")).optional(),
  language: z.enum(["zh", "en", "id"]).default("zh"),
}).strict();

export const comicDramaSetCurrentDramaSchema = z.object({ dramaId: id }).strict();

export const comicDramaSchema = comicDramaFieldsSchema.extend({
  id,
  outline: z.string().default(""),
  scriptContent: z.string().default(""),
  revision,
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}).strict();

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
}).extend({
  dramaId: id.optional(),
  dramaTitle: title.optional(),
  dramaSynopsis: z.string().trim().max(2000).optional(),
  sourceSeriesId: id.optional(),
  inheritCastAndStyle: z.boolean().optional(),
}).strict();

export const createComicEpisodeSchema = comicDramaSeriesFieldsSchema.partial({
  logline: true,
  seriesGroup: true,
  episodeNo: true,
  styleKey: true,
  aspectRatio: true,
  videoModel: true,
}).extend({
  sourceSeriesId: id.optional(),
  inheritCastAndStyle: z.boolean().optional(),
  initialScript: z.string().max(20_000).optional(),
}).strict();

export const updateComicDramaSeriesSchema = comicDramaSeriesFieldsSchema.extend({
  dramaId: id.optional(),
  expectedRevision: revision,
}).strict();

export const comicDramaSeriesSchema = comicDramaSeriesFieldsSchema.extend({
  id,
  dramaId: id,
  parentId: id.nullable(),
  revision,
  archivedAt: z.string().datetime().nullable(),
}).strict();

export const comicMaterialRefSchema = z.object({
  materialId: id,
  mediaId: id,
  name: z.string().trim().min(1).max(120).optional(),
}).strict();
export type ComicMaterialRef = z.infer<typeof comicMaterialRefSchema>;

export const comicShotSfxPositionSchema = z.enum(["start", "middle", "end"]);
export type ComicShotSfxPosition = z.infer<typeof comicShotSfxPositionSchema>;
export const comicShotSfxRefSchema = comicMaterialRefSchema.extend({
  position: comicShotSfxPositionSchema.optional(),
  offsetMs: z.number().int().min(0).max(60_000).optional(),
}).strict();
export type ComicShotSfxRef = z.infer<typeof comicShotSfxRefSchema>;

export const comicVideoMaterialRefSchema = comicMaterialRefSchema.extend({
  kind: z.enum(["image", "audio", "video", "last_frame"]),
}).strict();
export type ComicVideoMaterialRef = z.infer<typeof comicVideoMaterialRefSchema>;
export const comicClipModelAdaptationSchema = z.object({
  targetModelId: z.string().trim().min(1).max(128),
  originalResolution: z.enum(comicVideoResolutions).optional(),
  originalSourceDuration: z.literal(true).optional(),
  foldedCastRefs: z.array(z.object({
    characterId: id,
    kind: z.enum(["slot", "expression"]),
  }).strict()).max(64).optional(),
  foldedSceneRef: z.literal(true).optional(),
  foldedStyleRef: z.literal(true).optional(),
  foldedPropMediaIds: z.array(id).max(10).optional(),
  foldedExtraImageMediaIds: z.array(id).max(50).optional(),
}).strict();
export type ComicClipModelAdaptation = z.infer<typeof comicClipModelAdaptationSchema>;
export const comicClipVideoInputsSchema = z.object({
  references: z.array(comicVideoMaterialRefSchema).max(51).refine(refs =>
    new Set(refs.map(ref => `${ref.kind}:${ref.mediaId}`)).size === refs.length && refs.filter(ref => ref.kind === "last_frame").length <= 1),
  resolution: z.enum(comicVideoResolutions).optional(),
  sourceDuration: z.literal(true).optional(),
  audioMode: z.enum(comicVideoAudioModes).optional(),
  modelAdaptation: comicClipModelAdaptationSchema.optional(),
}).strict();

const shot = z.object({
  id,
  framingKey: dictionaryKey,
  movementKey: dictionaryKey,
  description: z.string().trim().max(2000),
  durationShare: z.number().int().min(1).max(100),
  sfxRefs: z.array(comicShotSfxRefSchema).max(5).optional(),
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
  sceneRef: comicMaterialRefSchema.nullable().optional(),
  propRefs: z.array(comicMaterialRefSchema).max(10).optional(),
  videoInputs: comicClipVideoInputsSchema.optional(),
  sfxRefs: z.array(comicMaterialRefSchema).max(10).optional(),
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

export type ComicInvalidMaterialRef = {
  role: "scene" | "prop" | "sfx" | ComicVideoMaterialRef["kind"];
  materialId: string;
  mediaId: string;
  name?: string;
  reason: "MISSING" | "ARCHIVED" | "WRONG_KIND" | "OUTDATED_VERSION";
};

export type ComicClipProgress = {
  keyframeState: "none" | "pending" | "running" | "ready" | "failed" | "recoverable" | "unknown";
  keyframeMediaId: string | null;
  keyframeApproved: boolean;
  keyframeCandidateAvailable?: boolean;
  keyframeStale: boolean;
  videoState: "none" | "pending" | "running" | "ready" | "failed" | "recoverable" | "unknown";
  latestVideoState?: ComicClipProgress["videoState"];
  videoTakeCount: number;
  adoptedVideoTakeId: string | null;
  adoptedVideoVersion: number | null;
  adoptedVideoMediaId: string | null;
  adoptedStale: boolean;
  castSnapshotStale: boolean;
  invalidMaterialRefs?: ComicInvalidMaterialRef[];
};

export const comicDramaClipSchema = z.object({
  id,
  dramaId: id.optional(),
  episodeId: id.optional(),
  revision,
  selectionRevision: revision.default(1),
  ordinal: z.number().int().positive(),
  draft: comicDramaClipDraftSchema,
}).strict();

export const comicAddClipSchema = z.object({
  expectedRevision: revision,
  afterClipId: id.optional(),
  insertIndex: z.number().int().min(0).max(500).optional(),
}).strict();

export const updateComicDramaClipSchema = z.object({
  expectedRevision: revision,
  expectedSeriesRevision: revision.optional(),
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

export type ComicDrama = z.infer<typeof comicDramaSchema>;
export type ComicDramaCreateInput = z.infer<typeof createComicDramaSchema>;
export type ComicDramaUpdateInput = z.infer<typeof updateComicDramaSchema>;
export type ComicDramaOutlinePolishInput = z.infer<typeof comicDramaOutlinePolishSchema>;
export type ComicDramaOutlinePolishResult = { outline: string; modelId: string };
export type ComicDramaScriptGenerateInput = z.infer<typeof comicDramaScriptGenerateSchema>;
export type ComicDramaScriptGenerateResult = { script: string; truncated: boolean; modelId: string };
export type ComicDramaOption = { id: string; title: string; archived: boolean };
export type ComicDramaEpisodeCreateInput = z.infer<typeof createComicEpisodeSchema>;
export type ComicDramaSeries = z.infer<typeof comicDramaSeriesSchema>;
export type ComicDramaClip = z.infer<typeof comicDramaClipSchema> & { progress?: ComicClipProgress };
export type ComicAddClipInput = z.infer<typeof comicAddClipSchema>;


export const comicDramaIdSchema = id;
export const comicDramaSetCurrentSchema = z.object({ seriesId: id }).strict();
export const comicDramaRevisionSchema = z.object({ expectedRevision: revision }).strict();
export const comicDramaScriptWriteSchema = comicDramaRevisionSchema.extend({
  content: z.string().max(20_000),
}).strict();
export const comicDramaSeriesStatusSchema = z.enum(["draft", "in_progress", "exported"]);
export type ComicDramaSeriesStatus = z.infer<typeof comicDramaSeriesStatusSchema>;
export const comicDramaListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  archived: z.enum(["true", "false"]).default("false"),
  status: comicDramaSeriesStatusSchema.optional(),
  cursor: z.string().max(80).optional(),
}).strict();
export const comicDramaSeriesListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  archived: z.enum(["true", "false"]).default("false"),
  status: comicDramaSeriesStatusSchema.optional(),
  dramaId: id.optional(),
  seriesGroup: z.string().trim().max(120).optional(),
  cursor: z.string().max(80).optional(),
}).strict();

export type ComicDramaHierarchyListQuery = z.infer<typeof comicDramaListSchema>;
export type ComicDramaSeriesInput = z.infer<typeof createComicDramaSeriesSchema>;
export type ComicDramaSeriesUpdate = z.infer<typeof updateComicDramaSeriesSchema>;
export type ComicDramaClipDraft = z.infer<typeof comicDramaClipDraftSchema>;
export type ComicDramaClipUpdate = z.infer<typeof updateComicDramaClipSchema>;
export type ComicDramaReorder = z.infer<typeof reorderComicDramaClipsSchema>;
export type ComicDramaListQuery = z.infer<typeof comicDramaSeriesListSchema>;

export type ComicDramaScript = { version: number; content: string };
export type ComicDramaScriptVersion = { version: number; content: string; source: "user" | "assistant"; createdAt: string };
export type ComicCurrencyAmount = {
  currency: "CNY" | "USD";
  amountMicros: number;
};
export type ComicEpisodeCostSummary = {
  settled: ComicCurrencyAmount[];
  settledTakeCount: number;
  quotedUnbilled: ComicCurrencyAmount[];
  unbilledReadyCount: number;
  remainingEstimate: {
    currency: "CNY" | "USD";
    amountMicros: number | null;
    unverifiedCount: number;
  };
  pendingReconcileCount: number;
};
export type ComicDramaEpisodeSummary = {
  dramaId?: string;
  dramaTitle?: string;
  episodeNo?: number;
  episodeCount?: number;
  seriesId: string;
  title: string;
  archived: boolean;
  clipCount: number;
  completedCount: number;
  generatingCount: number;
  totalDurationMs: number;
  estimatedMicros: number | null;
  estimatedUnverifiedCount: number;
  spentMicros: number;
  spentUnverifiedCount: number;
  currency: "CNY" | "USD";
  costs: ComicEpisodeCostSummary;
};
export type ComicDramaEpisodeBrief = {
  id: string;
  dramaId: string;
  episodeNo: number;
  title: string;
  logline: string;
  revision: number;
  archivedAt: string | null;
  updatedAt: string;
  clipCount: number;
  completedCount: number;
  generatingCount: number;
  hasRender: boolean;
  coverMediaId: string | null;
  status: ComicDramaSeriesStatus;
};
export type ComicDramaTreeEntry = ComicDrama & {
  updatedAt: string;
  episodeCount: number;
  clipCount: number;
  completedClipCount: number;
  generatingClipCount: number;
  exportedEpisodeCount: number;
  coverMediaId: string | null;
  status: ComicDramaSeriesStatus;
  episodes: ComicDramaEpisodeBrief[];
  castCount?: number;
  hasOutline?: boolean;
  hasScript?: boolean;
};
export type ComicDramaTreeListing = {
  dramas: ComicDramaTreeEntry[];
  nextCursor: string | null;
};
export type ComicDramaView = {
  drama: ComicDrama;
  episodes: ComicDramaEpisodeBrief[];
  cast: ComicSeriesCast[];
};
export type ComicDramaCastContent = {
  cast: ComicSeriesCast[];
  dramaRevision: number;
};
export type ComicDramaCurrentState = {
  dramaId: string | null;
  seriesId: string | null;
  drama: ComicDrama | null;
  episodeCount: number;
  castCount: number;
};
export type ComicDramaDetailHierarchy = {
  drama: { id: string; title: string; synopsis: string; revision: number; episodeCount: number };
  episode: { id: string; dramaId: string; episodeNo: number; title: string; revision: number; clipCount: number };
  clips: Array<{ id: string; episodeId: string; ordinal: number; scene: string; durationMs: number; revision: number }>;
};

export function buildComicDramaHierarchy(
  drama: Pick<ComicDrama, "id" | "title" | "synopsis" | "revision">,
  episode: Pick<ComicDramaSeries, "id" | "dramaId" | "episodeNo" | "title" | "revision">,
  clips: readonly ComicDramaClip[],
  episodeCount: number,
): ComicDramaDetailHierarchy {
  return {
    drama: {
      id: drama.id,
      title: drama.title,
      synopsis: drama.synopsis,
      revision: drama.revision,
      episodeCount,
    },
    episode: {
      id: episode.id,
      dramaId: episode.dramaId,
      episodeNo: episode.episodeNo ?? 1,
      title: episode.title,
      revision: episode.revision,
      clipCount: clips.length,
    },
    clips: clips.map(clip => ({
      id: clip.id,
      episodeId: clip.episodeId ?? episode.id,
      ordinal: clip.ordinal,
      scene: clip.draft.scene,
      durationMs: clip.draft.durationMs,
      revision: clip.revision,
    })),
  };
}

export type ComicDramaDetail = {
  drama?: ComicDrama;
  episodes?: ComicDramaEpisodeBrief[];
  hierarchy?: ComicDramaDetailHierarchy;
  series: ComicDramaSeries;
  clips: ComicDramaClip[];
  script: ComicDramaScript | null;
  cast: ComicSeriesCast[];
  dramaCastCount?: number;
  summary?: ComicDramaEpisodeSummary;
};
export type ComicDramaListing = {
  entries: Array<ComicDramaSeries & {
    dramaTitle?: string;
    updatedAt: string;
    clipCount: number;
    hasRender: boolean;
    coverMediaId?: string | null;
    status?: ComicDramaSeriesStatus;
    completedCount?: number;
    generatingCount?: number;
  }>;
  nextCursor: string | null;
};
export type ComicDramaContent = Pick<ComicDramaDetail, "clips" | "script" | "cast"> & { seriesRevision: number };

export interface ComicDramaRepository {
  listDramas?(owner: string, query: ComicDramaHierarchyListQuery): Promise<ComicDramaTreeListing>;
  listDramaOptions?(owner: string): Promise<ComicDramaOption[]>;
  getDrama?(owner: string, dramaId: string): Promise<{ drama: ComicDrama; episodes: ComicDramaEpisodeBrief[]; cast?: ComicSeriesCast[] }>;
  openDrama?(owner: string, dramaId: string): Promise<ComicDramaView>;
  currentDrama?(owner: string): Promise<ComicDramaCurrentState>;
  createDrama?(owner: string, input: ComicDramaCreateInput): Promise<{ drama: ComicDrama; detail: ComicDramaDetail | null }>;
  updateDrama?(owner: string, dramaId: string, input: ComicDramaUpdateInput): Promise<ComicDrama>;
  saveDramaOutline?(owner: string, dramaId: string, expectedRevision: number, outline: string): Promise<ComicDrama>;
  saveDramaScript?(owner: string, dramaId: string, expectedRevision: number, content: string): Promise<ComicDrama>;
  readDramaCast?(owner: string, dramaId: string): Promise<ComicDramaCastContent>;
  changeDramaCast?(owner: string, dramaId: string, expectedRevision: number, change: ComicCastChange): Promise<ComicDramaCastContent>;
  createEpisode?(owner: string, dramaId: string, input: ComicDramaEpisodeCreateInput): Promise<ComicDramaDetail>;
  archiveDrama?(owner: string, dramaId: string, expectedRevision: number): Promise<void>;
  removeDrama?(owner: string, dramaId: string, expectedRevision: number): Promise<void>;
  syncEpisodeCastFromDrama?(owner: string, seriesId: string, expectedRevision: number): Promise<ComicDramaContent>;
  list(owner: string, query: ComicDramaListQuery): Promise<ComicDramaListing>;
  get(owner: string, seriesId: string): Promise<ComicDramaDetail>;
  current(owner: string): Promise<string | null>;
  currentSummary?(owner: string): Promise<{ seriesId: string | null; summary: ComicDramaEpisodeSummary | null }>;
  open(owner: string, seriesId: string): Promise<ComicDramaDetail>;
  create(owner: string, fields: ComicDramaSeriesInput): Promise<ComicDramaDetail>;
  derive(owner: string, seriesId: string, sequel: boolean, inheritCastAndStyle?: boolean): Promise<ComicDramaDetail>;
  readCast(owner: string, seriesId: string): Promise<{ cast: ComicSeriesCast[]; seriesRevision: number }>;
  changeCast(owner: string, seriesId: string, expectedRevision: number, change: ComicCastChange): Promise<ComicDramaContent>;
  update(owner: string, seriesId: string, fields: ComicDramaSeriesUpdate): Promise<ComicDramaSeries>;
  archive(owner: string, seriesId: string, expectedRevision: number): Promise<void>;
  remove(owner: string, seriesId: string, expectedRevision: number): Promise<void>;
  scriptHistory?(owner: string, seriesId: string): Promise<ComicDramaScriptVersion[]>;
  saveScript(owner: string, seriesId: string, expectedRevision: number, content: string): Promise<ComicDramaContent>;
  addClip(owner: string, seriesId: string, expectedRevision: number, opts?: { afterClipId?: string; insertIndex?: number }): Promise<ComicDramaContent>;
  saveClip(owner: string, seriesId: string, clipId: string, input: ComicDramaClipUpdate): Promise<{ clip: ComicDramaClip; seriesRevision: number }>;
  copyClip(owner: string, seriesId: string, clipId: string, expectedRevision: number): Promise<ComicDramaContent>;
  removeClip(owner: string, seriesId: string, clipId: string, expectedRevision: number): Promise<ComicDramaContent>;
  reorder(owner: string, seriesId: string, input: ComicDramaReorder): Promise<ComicDramaContent>;
}

export * from "./library.js";
export * from "./cast.js";
export * from "./generation.js";
export * from "./models.js";
export * from "./timeline.js";
export * from "./edit.js";
export * from "./director.js";
export * from "./master-script.js";
export * from "./checks.js";
export * from "./compatibility.js";
