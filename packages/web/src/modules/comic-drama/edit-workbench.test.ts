// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComicDramaEditTaskView, ComicEditList } from "@lot-agent/core/comic-drama";
import { api } from "../../api/client.js";
import { LanguageProvider } from "../../i18n/index.js";
import { LOCALE_STORAGE_KEY } from "../../i18n/locale.js";
import { ComicDramaEditWorkspace } from "./ComicDramaEditWorkspace.js";
import { ComicEditsIndex } from "./ComicEditList.js";
import { comicEditApi } from "./edit-api.js";

const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactElement, locale: "zh" | "en" = "zh"): Promise<HTMLDivElement> {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "getProductLinks").mockResolvedValue({
    globle: locale === "zh" ? 0 : 1,
    webUrl: "https://example.com",
    tokenhubUrl: "https://example.com",
  } as never);
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(LanguageProvider, null, node));
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

describe("editing workbench drama tasks and episode-unit workflow", () => {
  it("renders separate drama editing tasks (with episode jump chips) and free tasks in ComicEditsIndex", async () => {
    const dramaId = uuid(1);
    const ep1Id = uuid(2);
    const ep2Id = uuid(3);
    const freeId = uuid(4);
    const payload: ComicEditList = {
      dramaTasks: [{
        id: uuid(10),
        dramaId,
        dramaTitle: "雨夜便利店",
        synopsis: "",
        styleKey: "thick_painting",
        aspectRatio: "9:16",
        archivedAt: null,
        lastSeriesId: ep2Id,
        lastEpisodeNo: 2,
        lastEpisodeTitle: "第二夜",
        episodeCount: 2,
        editedEpisodeCount: 1,
        exportedEpisodeCount: 1,
        coverMediaId: null,
        updatedAt: "2026-11-26T08:00:00.000Z",
        episodes: [
          {
            seriesId: ep1Id, episodeNo: 1, title: "第一夜", logline: "", aspectRatio: "9:16", archivedAt: null,
            clipCount: 3, adoptedClipCount: 3, editId: uuid(21), editRevision: 2,
            timelineClipCount: 3, timelineDurationMs: 12000, unaddedAdoptedCount: 0, outdatedAdoptedCount: 0,
            renderCount: 1, hasReadyRender: true, updatedAt: "2026-11-26T08:00:00.000Z",
          },
          {
            seriesId: ep2Id, episodeNo: 2, title: "第二夜", logline: "", aspectRatio: "9:16", archivedAt: null,
            clipCount: 2, adoptedClipCount: 2, editId: null, editRevision: null,
            timelineClipCount: 0, timelineDurationMs: 0, unaddedAdoptedCount: 2, outdatedAdoptedCount: 0,
            renderCount: 0, hasReadyRender: false, updatedAt: "2026-11-26T08:00:00.000Z",
          },
        ],
      }],
      entries: [{
        id: freeId,
        seriesId: null,
        taskKind: "free",
        title: "混剪预告片",
        revision: 1,
        updatedAt: "2026-11-26T07:00:00.000Z",
      }],
      nextCursor: null,
      lastEditId: uuid(21),
      lastEdit: {
        id: uuid(21), title: "《雨夜便利店》第 1 集", taskKind: "drama",
        dramaId, dramaTitle: "雨夜便利店", seriesId: ep1Id, episodeNo: 1, episodeTitle: "第一夜",
      },
    };
    vi.spyOn(comicEditApi, "list").mockResolvedValue(payload);
    const open = vi.fn();
    const openDramaTask = vi.fn();
    const host = await mount(createElement(ComicEditsIndex, {
      open,
      openDramaTask,
      openDramaHub: vi.fn(),
      browse: vi.fn(),
      currentDramaId: dramaId,
    }), "zh");

    expect(host.textContent).toContain("剧集剪辑任务");
    expect(host.textContent).toContain("任务单位：整部剧");
    expect(host.textContent).toContain("执行单位：分集");
    expect(host.textContent).toContain("《雨夜便利店》");
    expect(host.textContent).toContain("自由剪辑任务");
    expect(host.textContent).toContain("混剪预告片");

    const selectBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("选集进入操作台"));
    expect(selectBtn).toBeTruthy();
    act(() => { (selectBtn as HTMLButtonElement).click(); });
    expect(openDramaTask).toHaveBeenCalledWith(dramaId);

    const ep1Chip = Array.from(host.querySelectorAll("button.comic-ep-chip")).find(b => b.textContent?.includes("第 1 集"));
    expect(ep1Chip).toBeTruthy();
    act(() => { (ep1Chip as HTMLButtonElement).click(); });
    expect(openDramaTask).toHaveBeenCalledWith(dramaId, ep1Id);

    const openFreeBtn = host.querySelector(".comic-history-list .comic-history-title") as HTMLButtonElement;
    act(() => { openFreeBtn.click(); });
    expect(open).toHaveBeenCalledWith(freeId);
  });

  it("renders whole-drama episode selection view before opening episode workbench", async () => {
    const dramaId = uuid(1);
    const ep1Id = uuid(2);
    const ep2Id = uuid(3);
    const renderId = uuid(40);
    const selectionView: ComicDramaEditTaskView = {
      task: {
        id: uuid(10), dramaId, dramaTitle: "雨夜便利店", synopsis: "悬疑短剧", styleKey: "thick_painting",
        aspectRatio: "9:16", archivedAt: null, lastSeriesId: ep1Id, updatedAt: "2026-11-26T08:00:00.000Z",
      },
      episodes: [
        {
          seriesId: ep1Id, episodeNo: 1, title: "雨夜初遇", logline: "", aspectRatio: "9:16", archivedAt: null,
          clipCount: 3, adoptedClipCount: 3, editId: uuid(21), editRevision: 2,
          timelineClipCount: 3, timelineDurationMs: 14500, unaddedAdoptedCount: 0, outdatedAdoptedCount: 0,
          renderCount: 1, hasReadyRender: true, latestReadyRenderId: renderId,
          latestReadyRenderDurationMs: 14500, latestReadyRenderFps: 24, latestReadyRenderRevision: 2,
          latestReadyRenderAt: "2026-11-26T08:05:00.000Z", activeRenderStatus: null,
          updatedAt: "2026-11-26T08:05:00.000Z",
        },
        {
          seriesId: ep2Id, episodeNo: 2, title: "柜台暗门", logline: "", aspectRatio: "9:16", archivedAt: null,
          clipCount: 4, adoptedClipCount: 2, editId: null, editRevision: null,
          timelineClipCount: 0, timelineDurationMs: 0, unaddedAdoptedCount: 2, outdatedAdoptedCount: 0,
          renderCount: 0, hasReadyRender: false, latestReadyRenderId: null,
          updatedAt: "2026-11-26T08:00:00.000Z",
        },
      ],
      activeSeriesId: ep1Id,
      edit: null,
    };
    const getSpy = vi.spyOn(comicEditApi, "getDramaTask").mockResolvedValue(selectionView);
    const openSpy = vi.spyOn(comicEditApi, "openDramaTask").mockResolvedValue(selectionView);
    const dlSpy = vi.spyOn(comicEditApi, "downloadRender").mockResolvedValue({
      url: "https://example.com/ep1.mp4", filename: "ep1.mp4",
    });
    const openEpisodeEditor = vi.fn();

    const host = await mount(createElement(ComicDramaEditWorkspace, {
      dramaId,
      exit: vi.fn(),
      openDramaHub: vi.fn(),
      openEpisodeProduction: vi.fn(),
      openDramaTaskSelect: vi.fn(),
      openEpisodeEditor,
      openCreateEpisode: vi.fn(),
      openVideo: vi.fn(),
      setGuard: vi.fn(),
    }), "zh");

    expect(getSpy).toHaveBeenCalledWith(dramaId, undefined, expect.anything());
    expect(openSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain("整部剧剪辑任务");
    expect(host.textContent).toContain("选择分集进入操作台");
    expect(host.textContent).toContain("一集剧成果已合并");
    expect(host.textContent).toContain("试看本集成片");
    expect(host.textContent).toContain("下载本集 MP4");

    const previewBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("试看本集成片"));
    expect(previewBtn).toBeTruthy();
    await act(async () => {
      (previewBtn as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(dlSpy).toHaveBeenCalledWith(renderId, true);
    expect(host.querySelector(".comic-temp-preview-stage video")?.getAttribute("src")).toBe("https://example.com/ep1.mp4");

    const enterEp2 = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("进入操作台 · 第 2 集"));
    expect(enterEp2).toBeTruthy();
    act(() => { (enterEp2 as HTMLButtonElement).click(); });
    expect(openEpisodeEditor).toHaveBeenCalledWith(dramaId, ep2Id);
  });

  it("renders tiered hierarchy breadcrumbs, episode workbench title and merge panel across zh and en", async () => {
    const dramaId = uuid(1);
    const ep1Id = uuid(2);
    const ep2Id = uuid(3);
    const emptyView: ComicDramaEditTaskView = {
      task: {
        id: uuid(10), dramaId, dramaTitle: "新立项短剧", synopsis: "", styleKey: "thick_painting",
        aspectRatio: "9:16", archivedAt: null, lastSeriesId: null, updatedAt: "2026-11-26T08:00:00.000Z",
      },
      episodes: [],
      activeSeriesId: null,
      edit: null,
    };
    vi.spyOn(comicEditApi, "getDramaTask").mockResolvedValue(emptyView);

    const openCreateEpisode = vi.fn();
    const host = await mount(createElement(ComicDramaEditWorkspace, {
      dramaId,
      exit: vi.fn(),
      openDramaHub: vi.fn(),
      openEpisodeProduction: vi.fn(),
      openDramaTaskSelect: vi.fn(),
      openEpisodeEditor: vi.fn(),
      openCreateEpisode,
      openVideo: vi.fn(),
      setGuard: vi.fn(),
    }), "zh");

    expect(host.textContent).toContain("《新立项短剧》暂无可剪辑分集");
    expect(host.textContent).toContain("执行单位：分集");
    const createBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("创建第 1 集"));
    expect(createBtn).toBeTruthy();
    act(() => { (createBtn as HTMLButtonElement).click(); });
    expect(openCreateEpisode).toHaveBeenCalledWith(dramaId);

    act(() => root?.unmount());
    document.body.replaceChildren();

    const populatedView: ComicDramaEditTaskView = {
      task: {
        id: uuid(10), dramaId, dramaTitle: "Rainy Night Store", synopsis: "", styleKey: "thick_painting",
        aspectRatio: "9:16", archivedAt: null, lastSeriesId: ep1Id, updatedAt: "2026-11-26T08:00:00.000Z",
      },
      episodes: [
        {
          seriesId: ep1Id, episodeNo: 1, title: "Night 1", logline: "", aspectRatio: "9:16", archivedAt: null,
          clipCount: 2, adoptedClipCount: 2, editId: uuid(21), editRevision: 1,
          timelineClipCount: 0, timelineDurationMs: 0, unaddedAdoptedCount: 0, outdatedAdoptedCount: 0,
          renderCount: 0, hasReadyRender: false, updatedAt: "2026-11-26T08:00:00.000Z",
        },
        {
          seriesId: ep2Id, episodeNo: 2, title: "Night 2", logline: "", aspectRatio: "9:16", archivedAt: null,
          clipCount: 2, adoptedClipCount: 1, editId: null, editRevision: null,
          timelineClipCount: 0, timelineDurationMs: 0, unaddedAdoptedCount: 1, outdatedAdoptedCount: 0,
          renderCount: 0, hasReadyRender: false, updatedAt: "2026-11-26T08:00:00.000Z",
        },
      ],
      activeSeriesId: ep1Id,
      edit: {
        id: uuid(21), seriesId: ep1Id, dramaId, dramaTitle: "Rainy Night Store", episodeNo: 1, episodeTitle: "Night 1",
        taskKind: "drama", dramaEditTaskId: uuid(10), dramaArchivedAt: null,
        episodeClipCount: 2, episodeAdoptedCount: 2,
        title: "Rainy Night Store Ep 1", revision: 1, updatedAt: "2026-11-26T08:00:00.000Z",
        timeline: { schemaVersion: 1, aspectRatio: "9:16", video: [], voice: [], sfx: [], music: [], subtitles: [] },
        sources: [], audioSources: [],
      },
    };
    vi.spyOn(comicEditApi, "renders").mockResolvedValue({
      entries: [{
        id: uuid(99), editId: uuid(21), editRevision: 1, title: "Rainy Night Store Ep 1",
        status: "ready", createdAt: "2026-11-26T08:05:00.000Z", durationMs: 9500,
        mediaId: uuid(98), error: null, outputFps: 24, fpsMode: "auto", recoverable: false, ephemeral: false,
      }],
      nextCursor: null,
    });
    const hostWithRenderTimeline = {
      ...populatedView,
      edit: {
        ...populatedView.edit!,
        dramaEpisodes: populatedView.episodes,
        timeline: {
          schemaVersion: 1 as const,
          aspectRatio: "9:16" as const,
          video: [
            {
              id: uuid(51), takeId: uuid(61), sourceDurationMs: 5000, inMs: 0, outMs: 5000,
              volume: 1, transitionIn: { kind: "cut" as const, durationMs: 0 as const },
            },
            {
              id: uuid(52), takeId: uuid(62), sourceDurationMs: 5000, inMs: 0, outMs: 5000,
              volume: 1, transitionIn: { kind: "crossfade" as const, durationMs: 500 },
            },
          ],
          voice: [], sfx: [], music: [], subtitles: [],
        },
        sources: [
          {
            takeId: uuid(61), mediaId: uuid(71), seriesId: ep1Id, seriesTitle: "Night 1",
            clipId: uuid(81), scene: "Shot 1", version: 1, durationMs: 5000, aspectRatio: "9:16" as const, adopted: null,
          },
          {
            takeId: uuid(62), mediaId: uuid(72), seriesId: ep1Id, seriesTitle: "Night 1",
            clipId: uuid(82), scene: "Shot 2", version: 1, durationMs: 5000, aspectRatio: "9:16" as const, adopted: null,
          },
        ],
      },
    };
    vi.spyOn(comicEditApi, "openDramaTask").mockResolvedValue(hostWithRenderTimeline);
    const openEpisodeEditor = vi.fn();
    const openDramaTaskSelect = vi.fn();
    const hostEn = await mount(createElement(ComicDramaEditWorkspace, {
      dramaId,
      seriesId: ep1Id,
      exit: vi.fn(),
      openDramaHub: vi.fn(),
      openEpisodeProduction: vi.fn(),
      openDramaTaskSelect,
      openEpisodeEditor,
      openVideo: vi.fn(),
      setGuard: vi.fn(),
    }), "en");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hostEn.textContent).toContain("Workbench - Ep. 1 (Night 1)");
    expect(hostEn.textContent).toContain("Merge into episode deliverable");
    expect(hostEn.textContent).toContain("Merge into episode MP4");
    expect(hostEn.textContent).toContain("~9.5s");
    const nextEpBtn = Array.from(hostEn.querySelectorAll("button")).find(b => b.textContent?.includes("Next: Ep. 2"));
    expect(nextEpBtn).toBeTruthy();
    const select = hostEn.querySelector("select.comic-hierarchy-select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    act(() => {
      select.value = ep2Id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(openEpisodeEditor).toHaveBeenCalledWith(dramaId, ep2Id);
  });
});
