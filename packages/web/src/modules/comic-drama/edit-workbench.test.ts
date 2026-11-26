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
    expect(host.textContent).toContain("作业单位：分集");
    expect(host.textContent).toContain("《雨夜便利店》");
    expect(host.textContent).toContain("自由剪辑任务");
    expect(host.textContent).toContain("混剪预告片");

    const ep1Chip = Array.from(host.querySelectorAll("button.comic-ep-chip")).find(b => b.textContent?.includes("第 1 集"));
    expect(ep1Chip).toBeTruthy();
    act(() => { (ep1Chip as HTMLButtonElement).click(); });
    expect(openDramaTask).toHaveBeenCalledWith(dramaId, ep1Id);

    const openFreeBtn = host.querySelector(".comic-history-list .comic-history-title") as HTMLButtonElement;
    act(() => { openFreeBtn.click(); });
    expect(open).toHaveBeenCalledWith(freeId);
  });

  it("renders episode unit switcher and empty-episode guidance in ComicDramaEditWorkspace across zh and en", async () => {
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
    vi.spyOn(comicEditApi, "openDramaTask").mockResolvedValue(emptyView);

    const openCreateEpisode = vi.fn();
    const host = await mount(createElement(ComicDramaEditWorkspace, {
      dramaId,
      exit: vi.fn(),
      openDramaHub: vi.fn(),
      openEpisodeProduction: vi.fn(),
      openEpisodeEditor: vi.fn(),
      openCreateEpisode,
      openVideo: vi.fn(),
      setGuard: vi.fn(),
    }), "zh");

    expect(host.textContent).toContain("《新立项短剧》暂无可剪辑分集");
    expect(host.textContent).toContain("作业单位：分集");
    const createBtn = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("创建第 1 集"));
    expect(createBtn).toBeTruthy();
    act(() => { (createBtn as HTMLButtonElement).click(); });
    expect(openCreateEpisode).toHaveBeenCalledWith(dramaId);

    // Switch to populated drama edit workspace in English
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
          clipCount: 1, adoptedClipCount: 1, editId: uuid(21), editRevision: 1,
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
        title: "Rainy Night Store Ep 1", revision: 1, updatedAt: "2026-11-26T08:00:00.000Z",
        timeline: { schemaVersion: 1, aspectRatio: "9:16", video: [], voice: [], sfx: [], music: [], subtitles: [] },
        sources: [], audioSources: [],
      },
    };
    vi.spyOn(comicEditApi, "openDramaTask").mockResolvedValue(populatedView);
    vi.spyOn(comicEditApi, "renders").mockResolvedValue({ entries: [], nextCursor: null });
    const openEpisodeEditor = vi.fn();
    const hostEn = await mount(createElement(ComicDramaEditWorkspace, {
      dramaId,
      seriesId: ep1Id,
      exit: vi.fn(),
      openDramaHub: vi.fn(),
      openEpisodeProduction: vi.fn(),
      openEpisodeEditor,
      openVideo: vi.fn(),
      setGuard: vi.fn(),
    }), "en");

    expect(hostEn.textContent).toContain("Drama editing tasks");
    expect(hostEn.textContent).toContain("Unit: Episode");
    const ep2Btn = Array.from(hostEn.querySelectorAll("button.comic-episode-unit-btn")).find(b => b.textContent?.includes("Ep. 2"));
    expect(ep2Btn).toBeTruthy();
    act(() => { (ep2Btn as HTMLButtonElement).click(); });
    expect(openEpisodeEditor).toHaveBeenCalledWith(dramaId, ep2Id);
  });
});
