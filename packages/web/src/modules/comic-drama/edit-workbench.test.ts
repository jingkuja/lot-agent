// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComicDramaEditTaskView, ComicEdit, ComicEditList, ComicSpeechLines, ComicTimeline,
} from "@lot-agent/core/comic-drama";
import { api } from "../../api/client.js";
import { LanguageProvider } from "../../i18n/index.js";
import { LOCALE_STORAGE_KEY } from "../../i18n/locale.js";
import { ComicDramaEditWorkspace } from "./ComicDramaEditWorkspace.js";
import { ComicEditsIndex } from "./ComicEditList.js";
import { ComicEditWorkspace } from "./ComicEditWorkspace.js";
import { ComicTrimmedPreview } from "./ComicTrimmedPreview.js";
import { comicEditApi } from "./edit-api.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicLibraryApi } from "./library-api.js";

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

  it("does not loop comicEditApi.get under React.StrictMode when entering or reloading an episode workbench", async () => {
    const dramaId = uuid(1);
    const ep1Id = uuid(2);
    const editId = uuid(21);
    const baseEdit = {
      id: editId, seriesId: ep1Id, dramaId, dramaTitle: "雨夜便利店", episodeNo: 1, episodeTitle: "雨夜里的过期快乐",
      taskKind: "drama" as const, dramaEditTaskId: uuid(10), dramaArchivedAt: null,
      episodeClipCount: 4, episodeAdoptedCount: 0,
      title: "第 1 集", revision: 1, updatedAt: "2026-11-26T08:00:00.000Z",
      timeline: { schemaVersion: 1 as const, aspectRatio: "9:16" as const, video: [], voice: [], sfx: [], music: [], subtitles: [] },
      sources: [], audioSources: [],
    };
    const episodeRow = {
      seriesId: ep1Id, episodeNo: 1, title: "雨夜里的过期快乐", logline: "", aspectRatio: "9:16" as const, archivedAt: null,
      clipCount: 4, adoptedClipCount: 0, editId, editRevision: 1,
      timelineClipCount: 0, timelineDurationMs: 0, unaddedAdoptedCount: 0, outdatedAdoptedCount: 0,
      renderCount: 0, hasReadyRender: false, updatedAt: "2026-11-26T08:00:00.000Z",
    };
    const taskView: ComicDramaEditTaskView = {
      task: {
        id: uuid(10), dramaId, dramaTitle: "雨夜便利店", synopsis: "", styleKey: "thick_painting",
        aspectRatio: "9:16", archivedAt: null, lastSeriesId: ep1Id, updatedAt: "2026-11-26T08:00:00.000Z",
      },
      episodes: [episodeRow],
      activeSeriesId: ep1Id,
      edit: { ...baseEdit, dramaEpisodes: [episodeRow] },
    };
    vi.spyOn(comicEditApi, "openDramaTask").mockResolvedValue(taskView);
    vi.spyOn(comicEditApi, "renders").mockResolvedValue({ entries: [], nextCursor: null });
    vi.spyOn(comicGenerationApi, "videoHistory").mockResolvedValue({ entries: [], nextCursor: null });
    const getSpy = vi.spyOn(comicEditApi, "get").mockImplementation(async () => ({
      ...baseEdit,
      revision: 2,
      dramaEpisodes: [episodeRow],
    }));

    const host = await mount(createElement(React.StrictMode, null, createElement(ComicDramaEditWorkspace, {
      dramaId,
      seriesId: ep1Id,
      exit: vi.fn(),
      openDramaHub: vi.fn(),
      openEpisodeProduction: vi.fn(),
      openDramaTaskSelect: vi.fn(),
      openEpisodeEditor: vi.fn(),
      openVideo: vi.fn(),
      setGuard: vi.fn(),
    })), "zh");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain("操作台 - 第 1 集（雨夜里的过期快乐）");
    expect(getSpy).toHaveBeenCalledTimes(0);

    const reloadBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取工程");
    expect(reloadBtn).toBeTruthy();
    await act(async () => {
      (reloadBtn as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("removes source shelf and links upper stage video track selection with dialogue voice-over panel", async () => {
    const projectId = uuid(100);
    const seriesId = uuid(101);
    const clipItem1 = uuid(111);
    const clipItem2 = uuid(112);
    const take1 = uuid(121);
    const take2 = uuid(122);
    const media1 = uuid(131);
    const media2 = uuid(132);
    const voiceMedia1 = uuid(141);

    const editProject: ComicEdit = {
      id: projectId,
      seriesId,
      dramaId: uuid(102),
      dramaTitle: "雨夜便利店",
      episodeNo: 1,
      episodeTitle: "雨夜里的过期快乐",
      taskKind: "drama",
      dramaEditTaskId: uuid(103),
      dramaArchivedAt: null,
      episodeClipCount: 2,
      episodeAdoptedCount: 2,
      title: "《雨夜便利店》第 1 集",
      revision: 3,
      updatedAt: "2026-11-27T10:00:00.000Z",
      timeline: {
        schemaVersion: 1,
        aspectRatio: "9:16",
        video: [
          {
            id: clipItem1,
            takeId: take1,
            sourceDurationMs: 6042,
            inMs: 0,
            outMs: 6042,
            volume: 1,
            transitionIn: { kind: "cut", durationMs: 0 },
          },
          {
            id: clipItem2,
            takeId: take2,
            sourceDurationMs: 7042,
            inMs: 0,
            outMs: 7042,
            volume: 1,
            transitionIn: { kind: "cut", durationMs: 0 },
          },
        ],
        voice: [
          {
            id: uuid(151),
            mediaId: voiceMedia1,
            lineId: "line-1",
            anchor: { kind: "clip", videoItemId: clipItem1, offsetMs: 0 },
            durationMs: 2200,
            sourceInMs: 0,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
            loop: false,
          },
        ],
        sfx: [],
        music: [],
        subtitles: [
          {
            id: uuid(161),
            lineId: "line-1",
            text: "鲜食五折，最后十分钟。",
            anchor: { kind: "clip", videoItemId: clipItem1, offsetMs: 0 },
            durationMs: 2200,
          },
        ],
      },
      sources: [
        {
          takeId: take1,
          mediaId: media1,
          seriesId,
          seriesTitle: "雨夜里的过期快乐",
          clipId: uuid(171),
          clipOrdinal: 1,
          scene: "深夜双重打击",
          version: 1,
          durationMs: 6042,
          aspectRatio: "9:16",
          adopted: null,
        },
        {
          takeId: take2,
          mediaId: media2,
          seriesId,
          seriesTitle: "雨夜里的过期快乐",
          clipId: uuid(172),
          clipOrdinal: 2,
          scene: "暴雨冲进便利店",
          version: 1,
          durationMs: 7042,
          aspectRatio: "9:16",
          adopted: null,
        },
      ],
      audioSources: [{ id: voiceMedia1, durationMs: 2200 }],
    };

    const speechByItem: Record<string, ComicSpeechLines> = {
      [clipItem1]: {
        clipRevision: 1,
        presets: ["nova"],
        characters: [],
        lines: [{ id: "line-1", speaker: "店员", text: "鲜食五折，最后十分钟。", speed: 1, emotionKey: null }],
      },
      [clipItem2]: {
        clipRevision: 1,
        presets: ["nova"],
        characters: [],
        lines: [{ id: "line-2", speaker: "林夏", text: "雨太大了，先躲一躲。", speed: 1, emotionKey: null }],
      },
    };

    vi.spyOn(comicEditApi, "renders").mockResolvedValue({ entries: [], nextCursor: null });
    vi.spyOn(comicLibraryApi, "links").mockResolvedValue({
      url: "https://example.com/media.mp4",
      thumbnailUrl: null,
    });
    const linesSpy = vi.spyOn(comicEditApi, "lines").mockImplementation(async (_pid, itemId) => speechByItem[itemId]!);

    const host = await mount(createElement(ComicEditWorkspace, {
      id: projectId,
      initialData: editProject,
      exit: vi.fn(),
      openVideo: vi.fn(),
      setGuard: vi.fn(),
    }), "zh");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain("片源架");
    expect(host.textContent).not.toContain("收起片源架");
    expect(host.textContent).not.toContain("展开片源架");

    const stage = host.querySelector(".comic-edit-stage");
    expect(stage).toBeTruthy();
    expect(stage?.querySelector(".comic-timeline-preview")).toBeTruthy();
    expect(stage?.querySelector(".comic-video-track-card")).toBeTruthy();
    const dialoguePanel = stage?.querySelector(".comic-dialogue-panel");
    expect(dialoguePanel).toBeTruthy();

    const multitrack = host.querySelector(".comic-multitrack");
    expect(multitrack).toBeTruthy();
    expect(Boolean(dialoguePanel!.compareDocumentPosition(multitrack!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    const clipRows = Array.from(host.querySelectorAll(".comic-video-track li"));
    expect(clipRows).toHaveLength(2);
    expect(clipRows[0]?.textContent).toContain("已配音 1");
    expect(clipRows[0]?.textContent).toContain("字幕 1");
    expect(clipRows[0]?.textContent).toContain("配音中");
    expect(linesSpy).toHaveBeenCalledWith(projectId, clipItem1, expect.anything());
    expect(dialoguePanel?.textContent).toContain("深夜双重打击");
    expect(dialoguePanel?.textContent).toContain("鲜食五折，最后十分钟。");

    const clip2Btn = clipRows[1]?.querySelector(".comic-track-label") as HTMLButtonElement;
    await act(async () => {
      clip2Btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clip2Btn.getAttribute("aria-pressed")).toBe("true");
    expect(clipRows[1]?.textContent).toContain("配音中");
    expect(linesSpy).toHaveBeenCalledWith(projectId, clipItem2, expect.anything());
    expect(dialoguePanel?.querySelector(".comic-dialogue-context")?.textContent).toContain("暴雨冲进便利店");
    expect(dialoguePanel?.textContent).toContain("雨太大了，先躲一躲。");

    const prevBtn = dialoguePanel?.querySelector('button[aria-label="切换到上一片段"]') as HTMLButtonElement;
    expect(prevBtn).toBeTruthy();
    expect(prevBtn.disabled).toBe(false);
    await act(async () => {
      prevBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const clip1Btn = clipRows[0]?.querySelector(".comic-track-label") as HTMLButtonElement;
    expect(clip1Btn.getAttribute("aria-pressed")).toBe("true");
    expect(dialoguePanel?.querySelector(".comic-dialogue-context")?.textContent).toContain("深夜双重打击");

    const previewCard = stage?.querySelector(".comic-timeline-preview") as HTMLElement;
    const videoCard = stage?.querySelector(".comic-video-track-card") as HTMLElement;
    const dialogueCard = stage?.querySelector(".comic-dialogue-panel") as HTMLElement;
    const previewToggle = previewCard.querySelector(".comic-stage-collapse-btn") as HTMLButtonElement;
    const videoToggle = videoCard.querySelector(".comic-stage-collapse-btn") as HTMLButtonElement;
    const dialogueToggle = dialogueCard.querySelector(".comic-stage-collapse-btn") as HTMLButtonElement;
    expect(previewToggle).toBeTruthy();
    expect(videoToggle).toBeTruthy();
    expect(dialogueToggle).toBeTruthy();
    expect(previewToggle.getAttribute("aria-expanded")).toBe("true");
    expect(videoToggle.getAttribute("aria-expanded")).toBe("true");
    expect(dialogueToggle.getAttribute("aria-expanded")).toBe("true");
    expect(stage?.getAttribute("data-preview-collapsed")).toBeNull();
    expect(stage?.getAttribute("data-all-collapsed")).toBeNull();

    const previewVideoBefore = previewCard.querySelector("video");
    const linesCallCountBefore = linesSpy.mock.calls.length;

    act(() => {
      previewToggle.click();
    });
    expect(stage?.getAttribute("data-preview-collapsed")).toBe("true");
    expect(stage?.getAttribute("data-video-collapsed")).toBeNull();
    expect(stage?.getAttribute("data-dialogue-collapsed")).toBeNull();
    expect(stage?.getAttribute("data-all-collapsed")).toBeNull();

    act(() => {
      videoToggle.click();
      dialogueToggle.click();
    });

    expect(stage?.getAttribute("data-video-collapsed")).toBe("true");
    expect(stage?.getAttribute("data-dialogue-collapsed")).toBe("true");
    expect(stage?.getAttribute("data-all-collapsed")).toBe("true");
    expect(previewCard.classList.contains("is-collapsed")).toBe(true);
    expect(videoCard.classList.contains("is-collapsed")).toBe(true);
    expect(dialogueCard.classList.contains("is-collapsed")).toBe(true);
    expect(previewToggle.getAttribute("aria-expanded")).toBe("false");
    expect(videoToggle.getAttribute("aria-expanded")).toBe("false");
    expect(dialogueToggle.getAttribute("aria-expanded")).toBe("false");
    expect(previewToggle.textContent).toContain("展开");
    expect(videoToggle.textContent).toContain("展开");
    expect(dialogueToggle.textContent).toContain("展开");
    expect((previewCard.querySelector(".comic-stage-card-body") as HTMLElement).hidden).toBe(true);
    expect((videoCard.querySelector(".comic-editor-fields") as HTMLElement).hidden).toBe(true);
    expect((dialogueCard.querySelector(".comic-stage-card-body") as HTMLElement).hidden).toBe(true);
    expect(previewCard.querySelector("video")).toBe(previewVideoBefore);
    expect(linesSpy.mock.calls.length).toBe(linesCallCountBefore);

    act(() => {
      previewCard.click();
    });
    expect(stage?.getAttribute("data-preview-collapsed")).toBeNull();
    expect(stage?.getAttribute("data-all-collapsed")).toBeNull();
    expect(previewCard.classList.contains("is-collapsed")).toBe(false);
    expect(previewToggle.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      videoToggle.click();
      dialogueCard.click();
    });

    expect(stage?.getAttribute("data-video-collapsed")).toBeNull();
    expect(stage?.getAttribute("data-dialogue-collapsed")).toBeNull();
    expect(previewCard.classList.contains("is-collapsed")).toBe(false);
    expect(videoCard.classList.contains("is-collapsed")).toBe(false);
    expect(dialogueCard.classList.contains("is-collapsed")).toBe(false);
    expect(previewToggle.getAttribute("aria-expanded")).toBe("true");
    expect(videoToggle.getAttribute("aria-expanded")).toBe("true");
    expect(dialogueToggle.getAttribute("aria-expanded")).toBe("true");
    expect((previewCard.querySelector(".comic-stage-card-body") as HTMLElement).hidden).toBe(false);
    expect((videoCard.querySelector(".comic-editor-fields") as HTMLElement).hidden).toBe(false);
    expect((dialogueCard.querySelector(".comic-stage-card-body") as HTMLElement).hidden).toBe(false);
  });

  it("adapts widescreen 16:9 and 21:9 previews and toggles lightbox zoom without unmounting video", async () => {
    const takeId = uuid(201);
    const mediaId = uuid(202);
    const makeTimeline = (ratio: string): ComicTimeline => ({
      schemaVersion: 1,
      aspectRatio: ratio as ComicTimeline["aspectRatio"],
      video: [{
        id: uuid(211),
        takeId,
        sourceDurationMs: 5000,
        inMs: 0,
        outMs: 5000,
        volume: 1,
        transitionIn: { kind: "cut", durationMs: 0 },
      }],
      voice: [],
      sfx: [],
      music: [],
      subtitles: [],
    });
    const sources = [{
      takeId,
      mediaId,
      seriesId: uuid(203),
      seriesTitle: "宽屏样片",
      clipId: uuid(204),
      clipOrdinal: 1,
      scene: "城市全景",
      version: 1,
      durationMs: 5000,
      aspectRatio: "16:9" as const,
      adopted: null,
    }];
    vi.spyOn(comicLibraryApi, "links").mockResolvedValue({
      url: "https://example.com/wide.mp4",
      thumbnailUrl: null,
    });

    const host = await mount(createElement(ComicTrimmedPreview, {
      timeline: makeTimeline("16:9"),
      sources,
      seek: { ms: 0 },
      position: 0,
      onPosition: vi.fn(),
    }), "zh");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const stage = host.querySelector(".comic-timeline-stage");
    const panel = host.querySelector(".comic-preview-panel");
    const player = host.querySelector(".comic-timeline-player") as HTMLElement;
    expect(stage?.getAttribute("data-orientation")).toBe("landscape");
    expect(panel?.getAttribute("data-orientation")).toBe("landscape");
    expect(player.style.aspectRatio).toBe("16 / 9");
    expect(host.textContent).toContain("16:9");

    const videoBefore = host.querySelector(".comic-timeline-player video");
    expect(videoBefore).toBeTruthy();

    const expandBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "放大预览");
    expect(expandBtn).toBeTruthy();
    act(() => { (expandBtn as HTMLButtonElement).click(); });

    const shell = host.querySelector(".comic-preview-shell");
    expect(shell?.classList.contains("is-expanded")).toBe(true);
    expect(shell?.getAttribute("role")).toBe("dialog");
    expect(shell?.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector(".comic-preview-placeholder")).toBeTruthy();
    expect(host.querySelector(".comic-timeline-player video")).toBe(videoBefore);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(shell?.classList.contains("is-expanded")).toBe(false);
    expect(host.querySelector(".comic-preview-placeholder")).toBeFalsy();
    expect(host.querySelector(".comic-timeline-player video")).toBe(videoBefore);

    const zoomFab = host.querySelector('button[aria-label="放大视频画面"]') as HTMLButtonElement;
    expect(zoomFab).toBeTruthy();
    act(() => { zoomFab.click(); });
    expect(shell?.classList.contains("is-expanded")).toBe(true);

    const collapseBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "收起预览");
    expect(collapseBtn).toBeTruthy();
    act(() => { (collapseBtn as HTMLButtonElement).click(); });
    expect(shell?.classList.contains("is-expanded")).toBe(false);

    await act(async () => {
      root?.render(createElement(LanguageProvider, null, createElement(ComicTrimmedPreview, {
        timeline: makeTimeline("21:9"),
        sources,
        seek: { ms: 0 },
        position: 0,
        onPosition: vi.fn(),
      })));
      await Promise.resolve();
    });
    expect(stage?.getAttribute("data-orientation")).toBe("landscape");
    expect(player.style.aspectRatio).toBe("21 / 9");
  });
});
