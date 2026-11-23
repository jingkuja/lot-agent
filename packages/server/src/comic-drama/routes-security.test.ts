import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Pool } from "pg";
import type { ComicDramaDetail, ComicDramaRepository } from "@lot-agent/core/comic-drama";
import { createComicEditRoutes } from "./edit-routes.js";
import type { PgComicEdits } from "./edit-repository.js";
import type { ComicEditSpeech } from "./edit-speech.js";
import { createComicGenerationRoutes } from "./generation-routes.js";
import type { PgComicLibrary } from "./library-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";
import type { PgComicDramaRepository } from "./repository.js";
import { createComicDramaRoutes } from "./routes.js";

const seriesId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const clipId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const takeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeSeries(videoModel: string | null): ComicDramaDetail {
  return {
    series: {
      id: seriesId, parentId: null, title: "Test", logline: "", seriesGroup: null, episodeNo: null,
      styleKey: "webtoon", aspectRatio: "9:16", videoModel, revision: 1, archivedAt: null,
    },
    clips: [], script: null, cast: [],
  };
}

describe("comic-drama route security checks", () => {
  it("blocks unsupported video models on series create and update via comicVideoProfile", async () => {
    const detail = makeSeries(null);
    const repo = {
      create: vi.fn(async (_owner, fields) => makeSeries(fields.videoModel)),
      get: vi.fn(async () => detail),
      update: vi.fn(async (_owner, _id, fields) => ({ ...detail.series, videoModel: fields.videoModel, revision: 2 })),
    } as unknown as ComicDramaRepository;
    const canSelectModel = vi.fn(async () => true);

    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicDramaRoutes(repo, canSelectModel));

    const badCreate = await app.request("/series", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Bad", styleKey: "webtoon", aspectRatio: "9:16", videoModel: "veo3.1-unsupported" }),
    });
    expect(badCreate.status).toBe(400);
    expect(await badCreate.json()).toEqual({ code: "MODEL_UNAVAILABLE" });
    expect(canSelectModel).not.toHaveBeenCalled();

    const goodCreate = await app.request("/series", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Good", styleKey: "webtoon", aspectRatio: "9:16", videoModel: "doubao-seedance-2-5" }),
    });
    expect(goodCreate.status).toBe(201);
    expect(canSelectModel).toHaveBeenCalledWith(ownerId, "doubao-seedance-2-5");

    const badUpdate = await app.request(`/series/${seriesId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1, title: "Updated", logline: "", seriesGroup: null, episodeNo: null,
        styleKey: "webtoon", aspectRatio: "9:16", videoModel: "unknown-video-model",
      }),
    });
    expect(badUpdate.status).toBe(400);
    expect(await badUpdate.json()).toEqual({ code: "MODEL_UNAVAILABLE" });
  });

  it("enforces explicit charge acknowledgement on image-take and speech release and blocks non-compliant previews", async () => {
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    const riskyDetail: ComicDramaDetail = {
      ...makeSeries(null),
      script: { version: 1, content: "剧情展示血腥虐杀和肢解。" },
      clips: [{
        id: clipId, revision: 1, selectionRevision: 1, ordinal: 1,
        draft: {
          schemaVersion: 1, durationMs: 4000, scene: "测试场景",
          shots: [{ id: takeId, framingKey: "medium", movementKey: "fixed", description: "镜头描述", durationShare: 100 }],
          lines: [],
        },
      }],
    };
    const releaseSpeech = vi.fn(async () => {});
    app.route("/", createComicEditRoutes({} as PgComicEdits, { release: releaseSpeech } as unknown as ComicEditSpeech));
    app.route("/", createComicGenerationRoutes({
      pool: {} as Pool,
      library: {} as PgComicLibrary,
      series: { get: vi.fn(async () => riskyDetail) } as unknown as PgComicDramaRepository,
      media: { assertAvailable: () => {} } as unknown as ComicMediaLibrary,
      quotePrice: vi.fn(async () => ({ modelId: "gpt-image-2", amountMicros: 40_000 })),
      queue: { publishNewTask: vi.fn(), canResumePersisted: vi.fn(), resumePersisted: vi.fn() },
    }));

    const unackedImage = await app.request(`/image-takes/${takeId}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(unackedImage.status).toBe(400);

    const speechPayload = { expectedRevision: 1, expectedClipRevision: 1, voice: { kind: "preset", preset: "alloy" } };
    const unackedSpeech = await app.request(`/edits/${seriesId}/items/${clipId}/lines/${takeId}/speech/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(speechPayload),
    });
    expect(unackedSpeech.status).toBe(400);
    expect(releaseSpeech).not.toHaveBeenCalled();

    const ackedSpeech = await app.request(`/edits/${seriesId}/items/${clipId}/lines/${takeId}/speech/release`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...speechPayload, acknowledgePossibleCharge: true }),
    });
    expect(ackedSpeech.status).toBe(200);
    expect(releaseSpeech).toHaveBeenCalledWith(ownerId, seriesId, clipId, takeId, {
      ...speechPayload, acknowledgePossibleCharge: true,
    });

    const blockedPreview = await app.request(`/series/${seriesId}/generation-preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedSeriesRevision: 1, mode: "keyframe", targets: [{ clipId, expectedRevision: 1 }],
      }),
    });
    expect(blockedPreview.status).toBe(400);
    expect(await blockedPreview.json()).toEqual({ code: "CONTENT_COMPLIANCE_REJECTED" });
  });

  it("falls back to default video model on POST /series and supports summary, script history, clip insertion, and audition routes", async () => {
    const detail = makeSeries("doubao-seedance-2-5");
    const addClip = vi.fn(async () => ({ seriesRevision: 2, clips: [], script: null, cast: [] }));
    const repo = {
      create: vi.fn(async (_owner, fields) => makeSeries(fields.videoModel)),
      current: vi.fn(async () => seriesId),
      currentSummary: vi.fn(async () => ({
        seriesId,
        summary: {
          seriesId, title: "Test", archived: false, clipCount: 2, completedCount: 1, generatingCount: 1,
          totalDurationMs: 10_000, estimatedMicros: 50_000, estimatedUnverifiedCount: 0, spentMicros: 20_000, spentUnverifiedCount: 0, currency: "CNY" as const,
        },
      })),
      scriptHistory: vi.fn(async () => [{ version: 1, content: "第一版剧本", source: "user" as const, createdAt: new Date().toISOString() }]),
      addClip,
    } as unknown as ComicDramaRepository;
    const audition = vi.fn(async () => ({ mediaId: takeId, durationMs: 1800, cached: false }));
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicDramaRoutes(repo, async (_u, m) => m === "doubao-seedance-2-5", async () => "doubao-seedance-2-5"));
    app.route("/", createComicEditRoutes({} as PgComicEdits, { audition } as unknown as ComicEditSpeech));

    const created = await app.request("/series", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fallback", styleKey: "webtoon", aspectRatio: "9:16", videoModel: null }),
    });
    expect(created.status).toBe(201);
    expect((await created.json() as ComicDramaDetail).series.videoModel).toBe("doubao-seedance-2-5");

    const plainCurrent = await app.request("/series/current");
    expect(await plainCurrent.json()).toEqual({ seriesId });
    const summaryCurrent = await app.request("/series/current?summary=1");
    expect((await summaryCurrent.json() as { summary: { completedCount: number } }).summary.completedCount).toBe(1);

    const scriptRes = await app.request(`/series/${seriesId}/script`);
    expect((await scriptRes.json() as { versions: Array<{ version: number }> }).versions[0]?.version).toBe(1);

    const insertRes = await app.request(`/series/${seriesId}/clips`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, afterClipId: clipId }),
    });
    expect(insertRes.status).toBe(201);
    expect(addClip).toHaveBeenCalledWith(ownerId, seriesId, 1, { afterClipId: clipId, insertIndex: undefined });

    const auditionRes = await app.request("/voices/audition", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "测试试听台词", speed: 1.2, emotionKey: "gentle", voice: { kind: "preset", preset: "nova" } }),
    });
    expect(auditionRes.status).toBe(200);
    expect(audition).toHaveBeenCalledTimes(1);
    expect(detail.series.id).toBe(seriesId);
  });
});
