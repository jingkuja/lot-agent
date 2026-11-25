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
import { ComicDramaError, type PgComicDramaRepository } from "./repository.js";
import { createComicDramaRoutes } from "./routes.js";

const seriesId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dramaId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const clipId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const takeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeSeries(videoModel: string | null): ComicDramaDetail {
  return {
    series: {
      id: seriesId, dramaId, parentId: null, title: "Test", logline: "", seriesGroup: null, episodeNo: null,
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

  it("enforces model validation and revision conflict checks on /dramas hierarchy routes", async () => {
    const dramaRecord = {
      id: dramaId,
      title: "雨夜便利店",
      synopsis: "城市奇幻",
      outline: "",
      scriptContent: "",
      styleKey: "thick_painting",
      aspectRatio: "9:16" as const,
      videoModel: "doubao-seedance-2-5",
      revision: 2,
      archivedAt: null,
    };
    const listDramas = vi.fn(async () => ({ dramas: [], nextCursor: null }));
    const getDrama = vi.fn(async () => ({ drama: dramaRecord, episodes: [], cast: [] }));
    const currentDrama = vi.fn(async () => ({
      dramaId, seriesId: null, drama: dramaRecord, episodeCount: 0, castCount: 0,
    }));
    const saveDramaOutline = vi.fn(async (_u: string, _id: string, rev: number, outline: string) => {
      if (rev !== 2) throw new ComicDramaError("REVISION_CONFLICT", 2);
      return { ...dramaRecord, outline, revision: 3 };
    });
    const saveDramaScript = vi.fn(async (_u: string, _id: string, rev: number, scriptContent: string) => {
      if (rev !== 3) throw new ComicDramaError("REVISION_CONFLICT", 3);
      return { ...dramaRecord, scriptContent, revision: 4 };
    });
    const syncEpisodeCastFromDrama = vi.fn(async () => ({ seriesRevision: 2, clips: [], script: null, cast: [] }));
    const createDrama = vi.fn(async (_u: string, input: { videoModel?: string | null }) => ({
      drama: { ...dramaRecord, videoModel: input.videoModel ?? null },
      detail: null,
    }));
    const updateDrama = vi.fn(async (_u: string, _id: string, input: { expectedRevision: number }) => {
      if (input.expectedRevision !== 2) throw new ComicDramaError("REVISION_CONFLICT", 2);
      return { ...dramaRecord, revision: 3 };
    });
    const createEpisode = vi.fn(async (userId: string, dId: string, input: { title: string }) => {
      const base = makeSeries("doubao-seedance-2-5");
      return { ...base, series: { ...base.series, dramaId: dId, title: `${userId}:${input.title}`, episodeNo: 2 } };
    });
    const repo = {
      listDramas, getDrama, currentDrama, createDrama, updateDrama, saveDramaOutline, saveDramaScript,
      createEpisode, syncEpisodeCastFromDrama,
    } as unknown as ComicDramaRepository;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicDramaRoutes(repo, async (_u, m) => m === "doubao-seedance-2-5", async () => "doubao-seedance-2-5"));

    const listRes = await app.request("/dramas?query=雨夜");
    expect(listRes.status).toBe(200);
    expect(listDramas).toHaveBeenCalledWith(ownerId, { archived: "false", query: "雨夜" });

    const badCreate = await app.request("/dramas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新剧", styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "unsupported-model" }),
    });
    expect(badCreate.status).toBe(400);
    expect((await badCreate.json() as { code: string }).code).toBe("MODEL_UNAVAILABLE");

    const okCreate = await app.request("/dramas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "雨夜便利店", styleKey: "thick_painting", aspectRatio: "9:16", videoModel: null }),
    });
    expect(okCreate.status).toBe(201);
    expect((await okCreate.json() as { drama: { videoModel: string | null } }).drama.videoModel).toBe("doubao-seedance-2-5");

    const badPatch = await app.request(`/dramas/${dramaId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 2, title: "新剧名", synopsis: "新简介",
        styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "unsupported-model",
      }),
    });
    expect(badPatch.status).toBe(400);
    expect((await badPatch.json() as { code: string }).code).toBe("MODEL_UNAVAILABLE");

    const conflictUpdate = await app.request(`/dramas/${dramaId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1, title: "新剧名", synopsis: "新简介",
        styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "doubao-seedance-2-5",
      }),
    });
    expect(conflictUpdate.status).toBe(409);
    expect((await conflictUpdate.json() as { code: string }).code).toBe("REVISION_CONFLICT");

    const epRes = await app.request(`/dramas/${dramaId}/episodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "第 2 集：风铃", styleKey: "thick_painting", aspectRatio: "9:16", videoModel: null }),
    });
    expect(epRes.status).toBe(201);
    expect(createEpisode).toHaveBeenCalledTimes(1);
    expect((await epRes.json() as ComicDramaDetail).series.episodeNo).toBe(2);

    const curRes = await app.request("/dramas/current");
    expect(curRes.status).toBe(200);
    expect((await curRes.json() as { dramaId: string }).dramaId).toBe(dramaId);

    const outlineRes = await app.request(`/dramas/${dramaId}/outline`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 2, outline: "全剧大纲正文" }),
    });
    expect(outlineRes.status).toBe(200);
    expect((await outlineRes.json() as { outline: string }).outline).toBe("全剧大纲正文");

    const scriptRes = await app.request(`/dramas/${dramaId}/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 3, content: "全剧总剧本正文" }),
    });
    expect(scriptRes.status).toBe(200);
    expect((await scriptRes.json() as { scriptContent: string }).scriptContent).toBe("全剧总剧本正文");

    const syncRes = await app.request(`/series/${seriesId}/cast/sync-drama`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(syncRes.status).toBe(200);
    expect(syncEpisodeCastFromDrama).toHaveBeenCalledWith(ownerId, seriesId, 1);
  });

  it("supports drama options and AI outline polish / master script generation routes", async () => {
    const listDramaOptions = vi.fn(async () => [{ id: dramaId, title: "雨夜便利店", archived: false }]);
    const polishOutline = vi.fn(async () => ({ outline: "润色后的全剧大纲", modelId: "deepseek-v4.1-flash" }));
    const generateScript = vi.fn(async () => ({
      script: "【第 1 集：风铃】\n场景：便利店。",
      truncated: false,
      modelId: "deepseek-v4.1-flash",
    }));
    const repo = { listDramaOptions } as unknown as ComicDramaRepository;
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicDramaRoutes(repo, async () => true, undefined, undefined, { polishOutline, generateScript }));

    const optsRes = await app.request("/dramas/options");
    expect(optsRes.status).toBe(200);
    expect(await optsRes.json()).toEqual([{ id: dramaId, title: "雨夜便利店", archived: false }]);

    const badPolish = await app.request(`/dramas/${dramaId}/outline/polish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outline: "  " }),
    });
    expect(badPolish.status).toBe(400);

    const okPolish = await app.request(`/dramas/${dramaId}/outline/polish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outline: "女孩失恋来到便利店。", language: "zh" }),
    });
    expect(okPolish.status).toBe(200);
    expect(await okPolish.json()).toEqual({ outline: "润色后的全剧大纲", modelId: "deepseek-v4.1-flash" });

    const badScript = await app.request(`/dramas/${dramaId}/script/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeCount: 0 }),
    });
    expect(badScript.status).toBe(400);

    const okScript = await app.request(`/dramas/${dramaId}/script/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeCount: 8, notes: "节奏紧凑", outline: "大纲", language: "zh" }),
    });
    expect(okScript.status).toBe(200);
    expect(await okScript.json()).toEqual({
      script: "【第 1 集：风铃】\n场景：便利店。",
      truncated: false,
      modelId: "deepseek-v4.1-flash",
    });
  });
});
