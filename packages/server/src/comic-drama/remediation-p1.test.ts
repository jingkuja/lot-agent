import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Hono } from "hono";
import { ProviderError, type SpeechProvider } from "@lot-agent/core";
import {
  comicDramaClipDraftSchema, layoutComicTimeline,
  type ComicDramaClip, type ComicDramaDetail, type ComicEdit, type ComicGenerationQuote, type ComicTakeInput,
} from "@lot-agent/core/comic-drama";
import { PgComicEdits } from "./edit-repository.js";
import { createComicEditRoutes } from "./edit-routes.js";
import { ComicEditSpeech } from "./edit-speech.js";
import { PgComicGeneration, type FrozenVisualReference } from "./generation-repository.js";
import { createComicGenerationRoutes, createComicSeriesPreviewer } from "./generation-routes.js";
import { ComicSelectionConflictError } from "./library-db.js";
import type { PgComicLibrary } from "./library-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";
import { PgComicDramaRepository, summarizeEpisodeCosts, type EpisodeSpendRow } from "./repository.js";
import { PgComicSettings } from "./settings-repository.js";
import { PgComicVideo, visualReferenceKey } from "./video-repository.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = uuid(1);
const seriesId = uuid(2);
const clipA = uuid(10);
const clipB = uuid(11);
const take1 = uuid(20);
const take2 = uuid(21);
const matScene = uuid(30);
const mediaScene = uuid(31);
const matProp = uuid(32);
const mediaProp = uuid(33);
const sfxMat1 = uuid(34);
const sfxMedia1 = uuid(35);
const sfxMat2 = uuid(36);
const sfxMedia2 = uuid(37);
const sfxLegacyMat = uuid(38);
const sfxLegacyMedia = uuid(39);

function makeClip(id: string, ordinal: number, extra?: Partial<ComicDramaClip>): ComicDramaClip {
  return {
    id,
    revision: 2,
    selectionRevision: 1,
    ordinal,
    draft: comicDramaClipDraftSchema.parse({
      schemaVersion: 1,
      durationMs: 6000,
      scene: `场景 ${ordinal}`,
      shots: [{ id: uuid(100 + ordinal), framingKey: "medium", movementKey: "fixed", description: "测试镜头", durationShare: 100 }],
      lines: [],
    }),
    ...extra,
  };
}

describe("P1 #1: settled vs estimated vs pending-reconcile episode costs by currency", () => {
  it("keeps unbilled ready takes out of settled spend, uses actual settled charges, and separates CNY/USD across catalog switch", () => {
    const rows: EpisodeSpendRow[] = [
      // 1. Succeeded take not yet billed (quoted 1.00 CNY) -> must NOT enter settled
      { amountMicros: 1_000_000, unit: "image", durationMs: 6000, status: "ready", currency: "CNY", settledAmountMicros: null, settledCurrency: null },
      // 2. Settled charge differs from frozen quote (quoted 1.00 CNY, actual billed 1.35 CNY)
      { amountMicros: 1_000_000, unit: "image", durationMs: 6000, status: "ready", currency: "CNY", settledAmountMicros: "1350000", settledCurrency: "CNY" },
      // 3. Settled in USD (actual billed 0.55 USD)
      { amountMicros: 500_000, unit: "image", durationMs: 6000, status: "ready", currency: "USD", settledAmountMicros: "550000", settledCurrency: "USD" },
      // 4. Unbilled ready take quoted in USD (0.20 USD/sec * 4s = 0.80 USD)
      { amountMicros: 200_000, unit: "second", durationMs: 4000, status: "ready", currency: "USD", settledAmountMicros: null, settledCurrency: null },
      // 5. Unknown submission & gateway 502 failure -> pending reconcile
      { amountMicros: 1_000_000, unit: "image", durationMs: 6000, status: "unknown", currency: "CNY" },
      { amountMicros: 1_000_000, unit: "second", durationMs: 4000, status: "failed", error: "VIDEO_GATEWAY_FAILED", gatewayHttpStatus: 502, currency: "USD" },
    ];
    const clips = [makeClip(clipA, 1)];
    // Current catalog switched to USD
    const summary = summarizeEpisodeCosts(rows, clips, { imageMicros: 100_000, videoPerSecMicros: 50_000, currency: "USD" }, "USD");
    expect(summary.costs.settled).toEqual([
      { currency: "CNY", amountMicros: 1_350_000 },
      { currency: "USD", amountMicros: 550_000 },
    ]);
    expect(summary.costs.settledTakeCount).toBe(2);
    expect(summary.costs.quotedUnbilled).toEqual([
      { currency: "CNY", amountMicros: 1_000_000 },
      { currency: "USD", amountMicros: 800_000 },
    ]);
    expect(summary.costs.unbilledReadyCount).toBe(2);
    expect(summary.costs.pendingReconcileCount).toBe(2);
    expect(summary.costs.remainingEstimate).toEqual({
      currency: "USD",
      amountMicros: 100_000 + 50_000 * 6,
      unverifiedCount: 0,
    });

    // Episode with ONLY unbilled ready takes must show 0 settled spend
    const unbilledOnly = summarizeEpisodeCosts([rows[0]], clips, { imageMicros: 100_000, videoPerSecMicros: 50_000, currency: "USD" }, "USD");
    expect(unbilledOnly.costs.settled).toEqual([]);
    expect(unbilledOnly.spentMicros).toBe(0);
    expect(unbilledOnly.costs.quotedUnbilled).toEqual([{ currency: "CNY", amountMicros: 1_000_000 }]);
  });
});

describe("P1 #3: concurrent keyframe/video selection conflict without mutating clip revision", () => {
  it("rejects stale concurrent selection with 409 SELECTION_CONFLICT while preserving clip revision", async () => {
    const clipState = { revision: 2, selectionRevision: 1, keyframeTakeId: null as string | null, adoptedVideoTakeId: null as string | null };
    const makeClient = (): PoolClient => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("FROM lot_comic_drama.cd_series") && sql.includes("FOR UPDATE")) return { rows: [{ revision: 5 }], rowCount: 1 };
        if (sql.includes("SELECT revision, selection_revision")) {
          return { rows: [{ revision: clipState.revision, selectionRevision: clipState.selectionRevision }], rowCount: 1 };
        }
        if (sql.includes("SET keyframe_take_id=t.id")) {
          if (params?.[4] === clipState.revision && params?.[5] === clipState.selectionRevision) {
            clipState.keyframeTakeId = String(params[3]);
            clipState.selectionRevision += 1;
            return { rows: [{ selectionRevision: clipState.selectionRevision }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("SET adopted_video_take_id=t.id")) {
          if (params?.[4] === clipState.revision && params?.[5] === clipState.selectionRevision) {
            clipState.adoptedVideoTakeId = String(params[3]);
            clipState.selectionRevision += 1;
            return { rows: [{ selectionRevision: clipState.selectionRevision }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient);

    const pool = { connect: vi.fn(async () => makeClient()) } as unknown as Pool;
    const gen = new PgComicGeneration(pool);
    const vid = new PgComicVideo(pool);

    // Tab A approves keyframe take1 at selectionRevision=1 -> bumps to 2, clip.revision stays 2
    const ok1 = await gen.approve(ownerId, seriesId, clipA, take1, 2, 1);
    expect(ok1).toEqual({ selectionRevision: 2 });
    expect(clipState.revision).toBe(2);

    // Tab B concurrently approves keyframe take2 with stale selectionRevision=1 -> 409 SELECTION_CONFLICT
    await expect(gen.approve(ownerId, seriesId, clipA, take2, 2, 1)).rejects.toMatchObject({
      code: "SELECTION_CONFLICT",
      status: 409,
      currentSelectionRevision: 2,
    });

    // Tab A adopts video take1 at selectionRevision=2 -> bumps to 3, clip.revision stays 2
    const ok2 = await vid.adopt(ownerId, seriesId, clipA, take1, 2, 2);
    expect(ok2).toEqual({ selectionRevision: 3 });
    expect(clipState.revision).toBe(2);

    // Tab B concurrently adopts video take2 with stale selectionRevision=2 -> 409 SELECTION_CONFLICT
    await expect(vid.adopt(ownerId, seriesId, clipA, take2, 2, 2)).rejects.toBeInstanceOf(ComicSelectionConflictError);

    // Verify route returns 409 JSON with currentSelectionRevision
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicGenerationRoutes({
      pool, library: {} as PgComicLibrary, series: {} as PgComicDramaRepository, media: {} as ComicMediaLibrary,
      quotePrice: async () => null, queue: { publishNewTask: vi.fn(), canResumePersisted: vi.fn(), resumePersisted: vi.fn() },
    }));
    const res = await app.request(`/series/${seriesId}/clips/${clipA}/video/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ takeId: take2, expectedClipRevision: 2, expectedSelectionRevision: 2 }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "SELECTION_CONFLICT", currentSelectionRevision: 3 });
  });
});

describe("P1 #4: per-clip scene/prop reference validation and retryable query failure", () => {
  it("skips clip A with archived prop while preserving clip B's valid scene version and surfaces query failures", async () => {
    const clipWithArchivedProp = makeClip(clipA, 1, {
      draft: comicDramaClipDraftSchema.parse({
        schemaVersion: 1, durationMs: 6000, scene: "道具归档的分镜",
        shots: [{ id: uuid(110), framingKey: "wide", movementKey: "fixed", description: "镜头A", durationShare: 100 }],
        lines: [],
        propRefs: [{ materialId: matProp, mediaId: mediaProp, name: "旧手电" }],
      }),
    });
    const clipWithValidScene = makeClip(clipB, 2, {
      draft: comicDramaClipDraftSchema.parse({
        schemaVersion: 1, durationMs: 6000, scene: "场景有效的分镜",
        shots: [{ id: uuid(111), framingKey: "wide", movementKey: "fixed", description: "镜头B", durationShare: 100 }],
        lines: [],
        sceneRef: { materialId: matScene, mediaId: mediaScene, name: "雨夜街道" },
      }),
    });
    const detail: ComicDramaDetail = {
      series: {
        id: seriesId, parentId: null, title: "测试集", logline: "", seriesGroup: null, episodeNo: 1,
        styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "doubao-seedance-2-5", revision: 4, archivedAt: null,
      },
      clips: [clipWithArchivedProp, clipWithValidScene],
      script: null,
      cast: [],
    };
    let capturedInputs: ComicTakeInput[] = [];
    let capturedFrozen: FrozenVisualReference[] | undefined;
    const inspectReferences = vi.fn(async () => ({
      resolved: new Map([[visualReferenceKey({ kind: "scene", materialId: matScene, mediaId: mediaScene }), {
        kind: "scene" as const, materialId: matScene, mediaId: mediaScene, version: 3,
        mime: "image/png" as const, sizeBytes: 4096, width: 720, height: 1280, label: "雨夜街道",
      }]]),
      invalid: new Map([[visualReferenceKey({ kind: "prop", materialId: matProp, mediaId: mediaProp }), "ARCHIVED" as const]]),
    }));
    const previewSeries = createComicSeriesPreviewer({
      pool: {} as Pool,
      series: { get: vi.fn(async () => detail) },
      media: { assertAvailable: () => {}, assertVideoReferenceOrigin: () => {} },
      quotePrice: async () => ({ modelId: "gpt-image-2", amountMicros: 50_000, unit: "image", currency: "CNY" }),
      settings: { getStylePreset: async () => null },
      readStyleDictionary: async () => [],
      video: { frames: vi.fn(), references: vi.fn(async () => []), inspectReferences },
      repo: {
        quote: vi.fn(async (
          _owner: string, _scope: unknown, _stamp: string,
          price: { modelId: string; amountMicros: number } | null,
          inputs: ComicTakeInput[],
          skipped: ComicGenerationQuote["skipped"],
          _replace?: string[],
          frozen?: FrozenVisualReference[],
        ): Promise<ComicGenerationQuote> => {
          capturedInputs = inputs;
          capturedFrozen = frozen;
          return {
            confirmationId: uuid(999), expiresAt: new Date(Date.now() + 60_000).toISOString(),
            items: inputs.map(input => ({
              clipId: "clipId" in input ? input.clipId : "characterId" in input ? input.characterId : input.materialId,
              modelId: price!.modelId, unit: "image", quantity: 1, amountMicros: price!.amountMicros,
              referenceVersions: input.references.map(ref => ({ mediaId: ref.mediaId, version: ref.version })),
            })),
            skipped, totalMicros: price!.amountMicros * inputs.length, currency: "CNY",
          };
        }),
      },
    });

    const quote = await previewSeries(ownerId, { kind: "series", id: seriesId }, {
      expectedSeriesRevision: 4,
      mode: "keyframe",
      targets: [
        { clipId: clipA, expectedRevision: 2 },
        { clipId: clipB, expectedRevision: 2 },
      ],
    });
    expect(quote.skipped).toEqual([{
      clipId: clipA,
      reason: "INVALID_MATERIAL_REFERENCE",
      invalidReferences: [{ role: "prop", materialId: matProp, mediaId: mediaProp, name: "旧手电", reason: "ARCHIVED" }],
    }]);
    expect(quote.items).toHaveLength(1);
    expect(quote.items[0].clipId).toBe(clipB);
    expect(quote.items[0].referenceVersions).toEqual([{ mediaId: mediaScene, version: 3 }]);
    expect(capturedInputs).toHaveLength(1);
    expect("clipId" in capturedInputs[0] && capturedInputs[0].references[0]).toMatchObject({
      kind: "scene", mediaId: mediaScene, version: 3,
    });
    expect(capturedFrozen).toEqual([{ materialId: matScene, mediaId: mediaScene, version: 3 }]);

    // Transient DB error in inspectReferences must NOT be swallowed via .catch(() => [])
    inspectReferences.mockRejectedValueOnce(new Error("PG_CONNECTION_RESET"));
    await expect(previewSeries(ownerId, { kind: "series", id: seriesId }, {
      expectedSeriesRevision: 4,
      mode: "keyframe",
      targets: [{ clipId: clipB, expectedRevision: 2 }],
    })).rejects.toThrow("PG_CONNECTION_RESET");
  });

  it("rejects newly bound archived material on saveClip while allowing unrelated text edits on unchanged refs", async () => {
    const existingClip = makeClip(clipA, 1, {
      draft: comicDramaClipDraftSchema.parse({
        schemaVersion: 1, durationMs: 6000, scene: "旧场景",
        shots: [{ id: uuid(112), framingKey: "medium", movementKey: "fixed", description: "原镜头", durationShare: 100 }],
        lines: [],
        propRefs: [{ materialId: matProp, mediaId: mediaProp, name: "旧道具" }],
      }),
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("FROM lot_comic_drama.cd_series ")) {
          return { rows: [{
            id: seriesId, parentId: null, title: "T", logline: "", seriesGroup: null, episodeNo: 1,
            styleKey: "thick_painting", aspectRatio: "9:16", videoModel: null, revision: 3, archivedAt: null,
          }], rowCount: 1 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_clips WHERE series_id=$1 AND id=$2")) return { rows: [existingClip], rowCount: 1 };
        if (sql.includes("FROM lot_comic_drama.cd_materials m")) {
          return { rows: [{
            materialId: matScene, kind: "scene", archived: true, mediaId: mediaScene, mime: "image/png", version: 1, latestVersion: 1,
          }], rowCount: 1 };
        }
        if (sql.includes("UPDATE lot_comic_drama.cd_clips SET draft=")) {
          return { rows: [{ ...existingClip, revision: 3 }], rowCount: 1 };
        }
        if (sql.includes("UPDATE lot_comic_drama.cd_series SET revision=revision+1")) return { rows: [{ revision: 4 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const repo = new PgComicDramaRepository({ connect: async () => client } as unknown as Pool);

    // Binding an archived scene material must fail
    await expect(repo.saveClip(ownerId, seriesId, clipA, {
      expectedRevision: 2,
      draft: { ...existingClip.draft, sceneRef: { materialId: matScene, mediaId: mediaScene } },
    })).rejects.toMatchObject({ code: "INVALID_MATERIAL_REFERENCE" });

    // Unrelated text edit keeping unchanged archived propRef succeeds so user can still edit/remove it
    const saved = await repo.saveClip(ownerId, seriesId, clipA, {
      expectedRevision: 2,
      draft: { ...existingClip.draft, scene: "新场景说明" },
    });
    expect(saved.seriesRevision).toBe(4);
  });
});

describe("P1 #5 & P1 #6: audition release, per-attempt stale callback guard, and batch TTS preview/overflow/retry", () => {
  function createInMemorySpeechEnv() {
    type CacheEntry = {
      ownerId: string; fingerprint: string; kind: "dialogue" | "audition";
      status: string; mediaId: string | null; activeAttemptId: string | null;
      gatewayRequestId: string | null; updatedAt: number;
    };
    type AttemptEntry = {
      id: string; ownerId: string; fingerprint: string; kind: string; status: string;
      mediaId: string | null; gatewayRequestId: string | null; gatewayHttpStatus: number | null; error: string | null;
    };
    const cache = new Map<string, CacheEntry>();
    const attempts = new Map<string, AttemptEntry>();
    const mediaDurations = new Map<string, number>();
    let synthCount = 0;

    const execQuery = async (sql: string, params: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM lot_comic_drama.cd_speech_cache c LEFT JOIN")) {
        const row = cache.get(`${params[0]}:${params[1]}`);
        if (!row) return { rows: [], rowCount: 0 };
        const stale = row.status === "submitting" && Date.now() - row.updatedAt > 5 * 60_000;
        return { rows: [{
          status: stale ? "unknown" : row.status,
          mediaId: row.mediaId,
          durationMs: row.mediaId ? (mediaDurations.get(row.mediaId) ?? null) : null,
          activeAttemptId: row.activeAttemptId,
        }], rowCount: 1 };
      }
      if (sql.includes("SELECT status, active_attempt_id")) {
        const row = cache.get(`${params[0]}:${params[1]}`);
        const stale = row && row.status === "submitting" && Date.now() - row.updatedAt > 5 * 60_000;
        if (!row || !(["unknown", "released"].includes(row.status) || stale)) return { rows: [], rowCount: 0 };
        return { rows: [{ status: row.status, activeAttemptId: row.activeAttemptId }], rowCount: 1 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_speech_attempts") && sql.includes("SET status='released'")) {
        const att = attempts.get(String(params[0]));
        if (att && att.ownerId === params[1] && ["submitting", "unknown"].includes(att.status)) {
          att.status = "released";
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_speech_cache SET status='released'")) {
        const row = cache.get(`${params[0]}:${params[1]}`);
        if (row) { row.status = "released"; row.activeAttemptId = null; row.updatedAt = Date.now(); return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO lot_comic_drama.cd_speech_cache")) {
        const key = `${params[0]}:${params[1]}`;
        const existing = cache.get(key);
        if (!existing) {
          cache.set(key, {
            ownerId: String(params[0]), fingerprint: String(params[1]), kind: params[2] as "dialogue" | "audition",
            status: "submitting", mediaId: null, activeAttemptId: String(params[3]), gatewayRequestId: null, updatedAt: Date.now(),
          });
          return { rows: [], rowCount: 1 };
        }
        if (existing.status === "failed" || existing.status === "released") {
          existing.kind = params[2] as "dialogue" | "audition";
          existing.status = "submitting";
          existing.activeAttemptId = String(params[3]);
          existing.gatewayRequestId = null;
          existing.updatedAt = Date.now();
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO lot_comic_drama.cd_speech_attempts")) {
        attempts.set(String(params[0]), {
          id: String(params[0]), ownerId: String(params[1]), fingerprint: String(params[2]), kind: String(params[3]),
          status: "submitting", mediaId: null, gatewayRequestId: null, gatewayHttpStatus: null, error: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO lot_comic_drama.cd_media")) {
        mediaDurations.set(String(params[0]), Number(params[8]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_speech_cache SET status='ready'")) {
        const row = cache.get(`${params[0]}:${params[1]}`);
        if (row && row.activeAttemptId === params[4] && row.status === "submitting") {
          row.status = "ready";
          row.mediaId = String(params[2]);
          row.gatewayRequestId = (params[3] as string | null) ?? null;
          row.updatedAt = Date.now();
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_speech_cache SET status=$3")) {
        const row = cache.get(`${params[0]}:${params[1]}`);
        if (row && row.activeAttemptId === params[4] && row.status === "submitting") {
          row.status = String(params[2]);
          row.gatewayRequestId = (params[3] as string | null) ?? null;
          row.updatedAt = Date.now();
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_speech_attempts") && sql.includes("SET status='ready'")) {
        const att = attempts.get(String(params[0]));
        if (att && att.ownerId === params[1]) {
          att.status = "ready";
          att.mediaId = String(params[2]);
          att.gatewayRequestId = att.gatewayRequestId ?? ((params[3] as string | null) ?? null);
          att.gatewayHttpStatus = att.gatewayHttpStatus ?? 200;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_speech_attempts") && sql.includes("LATE_RESULT_IGNORED")) {
        const att = attempts.get(String(params[0]));
        if (att && att.ownerId === params[1]) {
          att.mediaId = att.mediaId ?? String(params[2]);
          att.gatewayRequestId = att.gatewayRequestId ?? ((params[3] as string | null) ?? null);
          att.error = att.error ?? "LATE_RESULT_IGNORED";
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE lot_comic_drama.cd_speech_attempts") && sql.includes("CASE WHEN status='submitting' THEN $3")) {
        const att = attempts.get(String(params[0]));
        if (att && att.ownerId === params[1]) {
          if (att.status === "submitting") att.status = String(params[2]);
          att.gatewayRequestId = att.gatewayRequestId ?? ((params[3] as string | null) ?? null);
          att.gatewayHttpStatus = att.gatewayHttpStatus ?? ((params[4] as number | null) ?? null);
          att.error = att.error ?? ((params[5] as string | null) ?? null);
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    let nextDurationMs = 1500;
    let mediaSeq = 500;
    const client = { query: vi.fn(execQuery), release: vi.fn() } as unknown as PoolClient;
    const pool = { query: vi.fn(execQuery), connect: vi.fn(async () => client) } as unknown as Pool;
    const media = {
      assertAvailable: () => {},
      upload: vi.fn(async (_req: Request, owner: string, _kind: string, save: (f: unknown) => Promise<unknown>) => {
        const id = uuid(++mediaSeq);
        const file = {
          id, owner, storageKey: `k/${id}.wav`, thumbnailKey: null,
          mime: "audio/wav", sizeBytes: 128, width: null, height: null, durationMs: nextDurationMs, hasThumbnail: false,
        };
        return save(file);
      }),
    } as unknown as ComicMediaLibrary;
    const setNextDuration = (ms: number) => { nextDurationMs = ms; };
    const bumpSynth = () => { synthCount += 1; return synthCount; };
    return { pool, cache, attempts, mediaDurations, media, setNextDuration, bumpSynth, getSynthCount: () => synthCount };
  }

  it("blocks retry after audition timeout until released, tracks each attempt, and blocks stale late callback overwrite", async () => {
    const env = createInMemorySpeechEnv();
    let releaseFirstProvider!: () => void;
    let call = 0;
    const provider: SpeechProvider = {
      synthesize: vi.fn(async () => {
        call = env.bumpSynth();
        if (call === 1) {
          throw new ProviderError("speech", "create", "TRANSPORT_ERROR", { gatewayRequestId: "gw-aud-1" });
        }
        if (call === 2) {
          // Simulate slow attempt that finishes AFTER release and Attempt #3 started
          await new Promise<void>(resolve => { releaseFirstProvider = resolve; });
          env.setNextDuration(1200);
          return { audio: new Uint8Array([1, 2, 3]), mime: "audio/wav", gatewayRequestId: "gw-aud-2-late" };
        }
        env.setNextDuration(1800);
        return { audio: new Uint8Array([4, 5, 6]), mime: "audio/wav", gatewayRequestId: "gw-aud-3-new" };
      }),
    };
    const speech = new ComicEditSpeech(env.pool, {} as PgComicEdits, env.media, {
      presetModel: "tts-1",
      ownerSpeech: async () => provider,
    });
    const payload = { text: "试听台词一", speed: 1, emotionKey: null, voice: { kind: "preset" as const, preset: "nova" as const } };

    // 1. Timeout marks cache & attempt #1 as unknown
    await expect(speech.audition(ownerId, payload, new AbortController().signal)).rejects.toMatchObject({ code: "EDIT_SPEECH_UNKNOWN" });
    expect(env.getSynthCount()).toBe(1);

    // 2. Retry before explicit release makes ZERO new TTS calls
    await expect(speech.audition(ownerId, payload, new AbortController().signal)).rejects.toMatchObject({ code: "EDIT_SPEECH_UNKNOWN" });
    expect(env.getSynthCount()).toBe(1);

    // 3. Audition release route requires acknowledgePossibleCharge: true
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicEditRoutes({} as PgComicEdits, speech));
    const unacked = await app.request("/voices/audition/release", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(unacked.status).toBe(400);
    const acked = await app.request("/voices/audition/release", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, acknowledgePossibleCharge: true }),
    });
    expect(acked.status).toBe(200);

    // 4. Start Attempt #2 (slow), simulate >5m stale submitting, release it, start Attempt #3
    const slowAttempt = speech.audition(ownerId, payload, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    const cacheRow = [...env.cache.values()][0]!;
    cacheRow.updatedAt = Date.now() - 6 * 60_000;
    await speech.releaseAudition(ownerId, payload);

    // Attempt #3 completes cleanly
    const freshTake = await speech.audition(ownerId, payload, new AbortController().signal);
    expect(freshTake.cached).toBe(false);
    expect(freshTake.durationMs).toBe(1800);

    // Late Attempt #2 finishes AFTER Attempt #3 -> must reject as superseded and NOT overwrite cache or Attempt #3
    releaseFirstProvider();
    await expect(slowAttempt).rejects.toMatchObject({ code: "EDIT_SPEECH_SUPERSEDED" });

    const cachedAfter = await speech.audition(ownerId, payload, new AbortController().signal);
    expect(cachedAfter.cached).toBe(true);
    expect(cachedAfter.mediaId).toBe(freshTake.mediaId);
    expect(env.getSynthCount()).toBe(3);

    // Every attempt (1, 2, 3) is individually traceable in cd_speech_attempts
    const allAttempts = [...env.attempts.values()];
    expect(allAttempts).toHaveLength(3);
    expect(allAttempts.map(a => a.status)).toEqual(["released", "released", "ready"]);
    expect(allAttempts[0].gatewayRequestId).toBe("gw-aud-1");
    expect(allAttempts[1].error).toBe("LATE_RESULT_IGNORED");
    expect(allAttempts[2].gatewayRequestId).toBe("gw-aud-3-new");
  });

  it("previews batch TTS scope without synthesizing, avoids silent truncation, persists partial wins, and reuses cache on retry", async () => {
    const env = createInMemorySpeechEnv();
    const editId = uuid(60);
    const videoItemId = uuid(61);
    const lineCachedId = uuid(62);
    const lineOverflowId = uuid(63);
    const lineFailId = uuid(64);

    let editState: ComicEdit = {
      id: editId, seriesId, title: "批量配音测试", revision: 1, updatedAt: new Date().toISOString(),
      timeline: {
        schemaVersion: 1, aspectRatio: "9:16",
        video: [{
          id: videoItemId, takeId: take1, sourceDurationMs: 4000, inMs: 0, outMs: 4000,
          volume: 1, transitionIn: { kind: "cut", durationMs: 0 },
        }],
        voice: [], sfx: [], music: [], subtitles: [],
      },
      sources: [{
        takeId: take1, mediaId: uuid(65), seriesId, seriesTitle: "测试集", clipId: clipA, scene: "测试", version: 1,
        durationMs: 4000, aspectRatio: "9:16", adopted: null,
      }],
      audioSources: [],
    };
    const clipDraft = comicDramaClipDraftSchema.parse({
      schemaVersion: 1, durationMs: 4000, scene: "测试",
      shots: [{ id: uuid(66), framingKey: "medium", movementKey: "fixed", description: "镜头", durationShare: 100 }],
      lines: [
        { id: lineCachedId, speaker: null, text: "第一句命中缓存", emotionKey: null, speed: 1 },
        { id: lineOverflowId, speaker: null, text: "第二句合成音频过长", emotionKey: null, speed: 1 },
        { id: lineFailId, speaker: null, text: "第三句触发上游失败", emotionKey: null, speed: 1 },
      ],
    });
    const origQuery = env.pool.query as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    env.pool.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM lot_comic_drama.cd_clips c JOIN")) {
        return { rows: [{ revision: 1, draft: clipDraft, characters: [] }], rowCount: 1 };
      }
      if (sql.includes("FROM lot_comic_drama.cd_dictionary")) return { rows: [], rowCount: 0 };
      return origQuery(sql, params);
    }) as unknown as Pool["query"];

    const edits = {
      get: vi.fn(async () => editState),
      update: vi.fn(async (_owner: string, _id: string, input: { title: string; timeline: ComicEdit["timeline"] }) => {
        editState = { ...editState, revision: editState.revision + 1, title: input.title, timeline: input.timeline };
        return editState;
      }),
    } as unknown as PgComicEdits;

    const provider: SpeechProvider = {
      synthesize: vi.fn(async req => {
        env.bumpSynth();
        if (req.text === "第一句命中缓存") {
          env.setNextDuration(1200);
          return { audio: new Uint8Array([1, 2]), mime: "audio/wav", gatewayRequestId: "gw-line-1" };
        }
        if (req.text === "第二句合成音频过长") {
          env.setNextDuration(5000); // exceeds remaining 2800ms!
          return { audio: new Uint8Array([3, 4]), mime: "audio/wav", gatewayRequestId: "gw-line-2" };
        }
        if (req.text === "第三句触发上游失败") {
          throw new ProviderError("speech", "create", "HTTP_ERROR", { httpStatus: 400, gatewayRequestId: "gw-line-3-fail" });
        }
        env.setNextDuration(800);
        return { audio: new Uint8Array([5, 6]), mime: "audio/wav", gatewayRequestId: "gw-line-3-ok" };
      }),
    };
    const speech = new ComicEditSpeech(env.pool, edits, env.media, {
      presetModel: "tts-1",
      ownerSpeech: async () => provider,
    });

    // Pre-populate line 1 into cache via single-line speak
    await speech.speak(ownerId, editId, videoItemId, lineCachedId, {
      expectedRevision: 1, expectedClipRevision: 1, voice: { kind: "preset", preset: "alloy" },
    }, new AbortController().signal);
    expect(env.getSynthCount()).toBe(1);

    // 1. Preview shows exact scope & fee status with ZERO new TTS calls
    const plan = await speech.previewAutoDialogue(ownerId, editId, {
      expectedRevision: 1, includeVoice: true, includeSubtitles: true,
    });
    expect(plan.cachedCount).toBe(1);
    expect(plan.toSynthesizeCount).toBe(2);
    expect(plan.feeStatus).toBe("unverified_gateway");
    expect(env.getSynthCount()).toBe(1);

    // 2. Execute batch with overflowMode="ask": line 1 persists, line 2 reports overflow (NOT truncated), line 3 reports failure
    const run1 = await speech.autoDialogue(ownerId, editId, {
      expectedRevision: 1, includeVoice: true, includeSubtitles: true, overflowMode: "ask",
    }, new AbortController().signal);
    expect(run1.voicedCount).toBe(1);
    expect(run1.cachedCount).toBe(1);
    expect(run1.synthesizedCount).toBe(1);
    expect(run1.overflowCount).toBe(1);
    expect(run1.failedCount).toBe(1);
    expect(editState.timeline.voice).toHaveLength(1); // Line 1 persisted despite later overflow & failure!
    const overflowItem = run1.items.find(item => item.lineId === lineOverflowId);
    expect(overflowItem).toMatchObject({ status: "overflow", audioDurationMs: 5000, remainingMs: 2800 });
    expect(overflowItem?.suggestedSpeed).toBeGreaterThan(1);
    const failedItem = run1.items.find(item => item.lineId === lineFailId);
    expect(failedItem).toMatchObject({ status: "failed", errorCode: "EDIT_SPEECH_UNAVAILABLE" });
    expect(env.getSynthCount()).toBe(3); // 1 (pre-cached) + 1 (line 2) + 1 (line 3 fail)

    // 3. Retry: trim line 2 (reuses cached audio -> 0 new synth!) and edit text on line 3 -> succeeds!
    const run2 = await speech.autoDialogue(ownerId, editId, {
      expectedRevision: run1.edit.revision,
      includeVoice: true,
      includeSubtitles: true,
      overflowMode: "ask",
      overrides: [
        { videoItemId, lineId: lineOverflowId, overflowAction: "trim" },
        { videoItemId, lineId: lineFailId, text: "第三句修改后成功" },
      ],
    }, new AbortController().signal);
    expect(run2.overflowCount).toBe(0);
    expect(run2.failedCount).toBe(0);
    expect(run2.cachedCount).toBe(1); // Line 2 reused from cache!
    expect(run2.synthesizedCount).toBe(0); // Remaining is 0 after trimmed line 2 filled clip, or if room left synthesizes only line 3
    expect(run2.items.find(item => item.lineId === lineOverflowId)?.status).toBe("trimmed");
    expect(env.getSynthCount()).toBe(3); // Zero duplicate TTS calls for lines 1 & 2!
  });
});

describe("P1 #7: concurrent episode opens on a small PG pool without nested connection checkout", () => {
  it("reuses the active transaction client when loading user preferences for cost estimation under pool.max=2", async () => {
    const maxConnections = 2;
    let inUse = 0;
    let nestedPoolQueryDuringTx = 0;
    const waiters: Array<() => void> = [];
    const prefsByOwner = new Map<string, string>([
      [uuid(1), "gpt-image-2.5-flare"],
      [uuid(2), "gpt-image-2.5-sunburst"],
      [uuid(3), "gpt-image-2"],
      [uuid(4), "gpt-image-2.5-flare"],
    ]);
    const priceByModel = new Map<string, number>([
      ["gpt-image-2.5-flare", 40_000],
      ["gpt-image-2.5-sunburst", 90_000],
      ["gpt-image-2", 20_000],
    ]);

    const runQuery = async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT preferences FROM lot_comic_drama.cd_user_state")) {
        const model = prefsByOwner.get(String(params[0])) ?? null;
        return { rows: [{ preferences: { defaultImageModel: model } }], rowCount: 1 };
      }
      if (sql.includes("FROM lot_comic_drama.cd_series ")) {
        return { rows: [{
          id: String(params[1]), parentId: null, title: "并发测试集", logline: "", seriesGroup: null, episodeNo: 1,
          styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "doubao-seedance-2-5", revision: 1, archivedAt: null,
        }], rowCount: 1 };
      }
      if (sql.includes("FROM lot_comic_drama.cd_clips WHERE series_id=")) {
        return { rows: [makeClip(clipA, 1)], rowCount: 1 };
      }
      if (sql.includes("FROM lot_comic_drama.cd_clips c")) {
        return { rows: [{
          clipId: clipA, keyframeTakeId: null, keyframeMediaId: null, adoptedVideoTakeId: null,
          keyframeTakeState: null, keyframeTakeMediaId: null, keyframeTakeRev: null,
          latestImageState: null, latestVideoState: null, videoTakeCount: 0, readyVideoCount: 0,
          adoptedVersion: null, adoptedMediaId: null, adoptedClipRev: null, adoptedRefs: null,
        }], rowCount: 1 };
      }
      if (sql.includes("AS generating")) return { rows: [{ generating: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };

    const pool = {
      async connect(): Promise<PoolClient> {
        while (inUse >= maxConnections) {
          await new Promise<void>(resolve => waiters.push(resolve));
        }
        inUse += 1;
        return {
          query: async (sql: string, params?: unknown[]) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return runQuery(sql, params);
          },
          release: () => {
            inUse -= 1;
            waiters.shift()?.();
          },
        } as unknown as PoolClient;
      },
      async query(sql: string, params?: unknown[]) {
        if (inUse >= maxConnections) {
          nestedPoolQueryDuringTx += 1;
          throw new Error("POOL_DEADLOCK_DETECTED");
        }
        return runQuery(sql, params);
      },
    } as unknown as Pool;

    const settings = new PgComicSettings(pool);
    const repo = new PgComicDramaRepository(pool, async (owner, _videoModel, db) => {
      const pref = (await settings.getPreferences(owner, db)).defaultImageModel ?? "gpt-image-2";
      return { imageMicros: priceByModel.get(pref) ?? 20_000, videoPerSecMicros: 100_000, currency: "CNY" };
    });

    const owners = [uuid(1), uuid(2), uuid(3), uuid(4)];
    const results = await Promise.all(owners.map((owner, idx) => repo.open(owner, uuid(700 + idx))));
    expect(nestedPoolQueryDuringTx).toBe(0);
    expect(results.map(r => r.summary?.costs.remainingEstimate.amountMicros)).toEqual([
      40_000 + 600_000,
      90_000 + 600_000,
      20_000 + 600_000,
      40_000 + 600_000,
    ]);
  });
});

describe("P2 #8: shot-level SFX initialization into edit project and sync after video reorder", () => {
  it("creates distinct clip-anchored SFX blocks per shot plus legacy card SFX and preserves sync on clip reorder", async () => {
    const clipDraft = comicDramaClipDraftSchema.parse({
      schemaVersion: 1,
      durationMs: 8000,
      scene: "双镜头雨夜",
      shots: [
        {
          id: uuid(801), framingKey: "wide", movementKey: "fixed", description: "镜头1", durationShare: 50,
          sfxRefs: [{ materialId: sfxMat1, mediaId: sfxMedia1, name: "推门声", position: "start" }],
        },
        {
          id: uuid(802), framingKey: "close_up", movementKey: "push", description: "镜头2", durationShare: 50,
          sfxRefs: [{ materialId: sfxMat2, mediaId: sfxMedia2, name: "雷声", position: "middle" }],
        },
      ],
      lines: [],
      sfxRefs: [{ materialId: sfxLegacyMat, mediaId: sfxLegacyMedia, name: "旧环境雨声" }],
    });

    let insertedTimeline: ComicEdit["timeline"] | null = null;
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("ARRAY(SELECT adopted_video_take_id")) {
          return { rows: [{ aspect: "9:16", adopted: [take1, take2] }], rowCount: 1 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_takes t JOIN")) {
          return { rows: [
            {
              takeId: take1, mediaId: uuid(810), seriesId, seriesTitle: "测试集", clipId: clipA,
              scene: "双镜头雨夜", version: 1, durationMs: 8000, aspectRatio: "9:16", adopted: null,
            },
            {
              takeId: take2, mediaId: uuid(811), seriesId, seriesTitle: "测试集", clipId: clipB,
              scene: "第二段", version: 1, durationMs: 4000, aspectRatio: "9:16", adopted: null,
            },
          ], rowCount: 2 };
        }
        if (sql.includes("SELECT c.id, c.draft FROM lot_comic_drama.cd_clips")) {
          return { rows: [{ id: clipA, draft: clipDraft }], rowCount: 1 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_media")) {
          return { rows: [
            { id: sfxMedia1, durationMs: 1200 },
            { id: sfxMedia2, durationMs: 1500 },
            { id: sfxLegacyMedia, durationMs: 6000 },
          ], rowCount: 3 };
        }
        if (sql.includes("INSERT INTO lot_comic_drama.cd_edits")) {
          insertedTimeline = params[3] as ComicEdit["timeline"];
          return { rows: [{
            id: uuid(820), seriesId, title: params[2], revision: 1, updatedAt: new Date(), timeline: insertedTimeline,
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;

    const edits = new PgComicEdits({ connect: async () => client } as unknown as Pool);
    const created = await edits.create(ownerId, { title: "音效带入工程", seriesId });
    expect(created.timeline.video).toHaveLength(2);
    expect(created.timeline.sfx).toHaveLength(3);
    const firstVideoId = created.timeline.video[0].id;
    const shot1Sfx = created.timeline.sfx.find(item => item.mediaId === sfxMedia1);
    const shot2Sfx = created.timeline.sfx.find(item => item.mediaId === sfxMedia2);
    const legacySfx = created.timeline.sfx.find(item => item.mediaId === sfxLegacyMedia);
    expect(shot1Sfx?.anchor).toEqual({ kind: "clip", videoItemId: firstVideoId, offsetMs: 0 });
    expect(shot2Sfx?.anchor).toEqual({ kind: "clip", videoItemId: firstVideoId, offsetMs: 6000 });
    expect(legacySfx?.anchor).toEqual({ kind: "clip", videoItemId: firstVideoId, offsetMs: 0 });

    // Drag/reorder: move clip 2 (4000ms) ahead of clip 1 (8000ms) -> SFX layout shifts by +4000ms in sync!
    const reordered = {
      ...created.timeline,
      video: [created.timeline.video[1], created.timeline.video[0]],
    };
    const layoutAfterDrag = layoutComicTimeline(reordered);
    const shot1Pos = layoutAfterDrag.sfx.find(entry => entry.id === shot1Sfx!.id);
    const shot2Pos = layoutAfterDrag.sfx.find(entry => entry.id === shot2Sfx!.id);
    expect(shot1Pos?.startMs).toBe(4000);
    expect(shot2Pos?.startMs).toBe(10000);
  });
});
