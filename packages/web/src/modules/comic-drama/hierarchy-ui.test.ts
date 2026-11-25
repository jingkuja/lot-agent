// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comicSystemDictionary,
  type ComicDramaClip, type ComicDramaEpisodeBrief, type ComicDramaSeries, type ComicDramaTreeListing,
} from "@lot-agent/core/comic-drama";
import { api } from "../../api/client.js";
import { LanguageProvider } from "../../i18n/index.js";
import { LOCALE_STORAGE_KEY } from "../../i18n/locale.js";
import { ComicClipOriginBadge, ComicWorkspaceHierarchyBar } from "./ComicHierarchyBar.js";
import { SeriesHistory } from "./SeriesHistory.js";
import { Storyboard } from "./Storyboard.js";
import { comicDramaApi } from "./api.js";
import { comicLibraryApi } from "./library-api.js";

const uuid = (n: number) => `abcdef01-2345-4567-8abc-${String(n).padStart(12, "0")}`;

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

const makeEpisodes = (dramaId: string): ComicDramaEpisodeBrief[] => [
  {
    id: uuid(10),
    dramaId,
    episodeNo: 1,
    title: "第一夜：风铃",
    logline: "雨夜重逢",
    revision: 2,
    archivedAt: null,
    updatedAt: "2026-11-20T10:00:00.000Z",
    clipCount: 3,
    completedCount: 3,
    generatingCount: 0,
    hasRender: true,
    coverMediaId: null,
    status: "exported",
  },
  {
    id: uuid(11),
    dramaId,
    episodeNo: 2,
    title: "第二夜：热咖啡",
    logline: "旧客上门",
    revision: 1,
    archivedAt: null,
    updatedAt: "2026-11-21T10:00:00.000Z",
    clipCount: 2,
    completedCount: 1,
    generatingCount: 0,
    hasRender: false,
    coverMediaId: null,
    status: "in_progress",
  },
];

describe("3-tier drama -> episode -> clip workspace UI", () => {
  it("renders ComicWorkspaceHierarchyBar across zh and en and triggers episode switching", async () => {
    const dramaId = uuid(1);
    const episodes = makeEpisodes(dramaId);
    const onSelectEpisode = vi.fn();
    const onAddEpisode = vi.fn();

    const hostZh = await mount(createElement(ComicWorkspaceHierarchyBar, {
      dramaTitle: "雨夜便利店",
      episodeCount: 2,
      episodeId: uuid(11),
      episodeNo: 2,
      episodeTitle: "第二夜：热咖啡",
      episodes,
      activeClipOrdinal: 2,
      activeClipScene: "柜台特写",
      totalClips: 2,
      locked: false,
      onSelectEpisode,
      onAddEpisode,
      onEditDrama: vi.fn(),
      onOpenDramaHistory: vi.fn(),
    }), "zh");

    expect(hostZh.textContent).toContain("整部剧集");
    expect(hostZh.textContent).toContain("《雨夜便利店》");
    expect(hostZh.textContent).toContain("共 2 集");
    expect(hostZh.textContent).toContain("第 2 集");
    expect(hostZh.textContent).toContain("分镜 2/2");
    expect(hostZh.textContent).toContain("柜台特写");

    const select = hostZh.querySelector("select");
    expect(select).toBeTruthy();
    act(() => {
      if (select) {
        select.value = uuid(10);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onSelectEpisode).toHaveBeenCalledWith(uuid(10));

    act(() => root?.unmount());
    document.body.replaceChildren();

    const hostEn = await mount(createElement(ComicWorkspaceHierarchyBar, {
      dramaTitle: "Rainy Night Store",
      episodeCount: 2,
      episodeId: uuid(11),
      episodeNo: 2,
      episodeTitle: "Night 2",
      episodes,
      activeClipOrdinal: 1,
      activeClipScene: "Counter",
      totalClips: 2,
      locked: false,
      onSelectEpisode: vi.fn(),
      onAddEpisode,
      onEditDrama: vi.fn(),
      onOpenDramaHistory: vi.fn(),
    }), "en");

    expect(hostEn.textContent).toContain("Drama series");
    expect(hostEn.textContent).toContain("Rainy Night Store");
    expect(hostEn.textContent).toContain("2 episodes");
    expect(hostEn.textContent).toContain("Ep. 2");
    expect(hostEn.textContent).toContain("Clip 1/2");
  });

  it("shows ComicClipOriginBadge alongside Storyboard shot editor heading", async () => {
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async (domain) => [
      ...(comicSystemDictionary[domain] ?? []),
    ] as never);
    const dramaId = uuid(1);
    const series: ComicDramaSeries = {
      id: uuid(11),
      dramaId,
      parentId: uuid(10),
      title: "第二夜：热咖啡",
      logline: "旧客上门",
      seriesGroup: "雨夜便利店",
      episodeNo: 2,
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: "doubao-seedance-2-5",
      revision: 1,
      archivedAt: null,
    };
    const clip2: ComicDramaClip = {
      id: uuid(22),
      dramaId,
      episodeId: uuid(11),
      revision: 1,
      selectionRevision: 1,
      ordinal: 2,
      draft: {
        schemaVersion: 1,
        durationMs: 4000,
        scene: "咖啡机蒸汽",
        shots: [{ id: uuid(32), framingKey: "closeup", movementKey: "fixed", description: "特写", durationShare: 100 }],
        lines: [],
      },
    };
    const host = await mount(createElement(Storyboard, {
      dramaTitle: "雨夜便利店",
      series,
      clips: [clip2],
      cast: [],
      drafts: { [clip2.id]: { draft: clip2.draft } },
      disabled: false,
      locked: false,
      selected: clip2.id,
      select: vi.fn(),
      edit: vi.fn(),
      add: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
    }), "zh");

    expect(host.querySelector("h2")?.textContent).toBe("分镜 2");
    expect(host.querySelector(".comic-clip-origin")?.textContent).toContain("雨夜便利店");
    expect(host.querySelector(".comic-clip-origin")?.textContent).toContain("第 2 集");
    expect(host.querySelector(".comic-clip-origin")?.textContent).toContain("第二夜：热咖啡");

    act(() => root?.unmount());
    document.body.replaceChildren();
    const badgeHost = await mount(createElement(ComicClipOriginBadge, {
      dramaTitle: "雨夜便利店",
      episodeNo: 2,
      episodeTitle: "第二夜：热咖啡",
      clipOrdinal: 2,
      totalClips: 5,
    }), "zh");
    expect(badgeHost.textContent).toContain("分镜 2/5");
  });

  it("renders grouped 3-tier dramas and episodes in SeriesHistory", async () => {
    const dramaId = uuid(1);
    const episodes = makeEpisodes(dramaId);
    const tree: ComicDramaTreeListing = {
      dramas: [{
        id: dramaId,
        title: "雨夜便利店",
        synopsis: "都会夜归人的奇幻便利店",
        styleKey: "thick_painting",
        aspectRatio: "9:16",
        videoModel: "doubao-seedance-2-5",
        revision: 3,
        archivedAt: null,
        updatedAt: "2026-11-21T10:00:00.000Z",
        episodeCount: 2,
        clipCount: 5,
        completedClipCount: 4,
        generatingClipCount: 0,
        exportedEpisodeCount: 1,
        coverMediaId: null,
        status: "in_progress",
        episodes,
      }],
      nextCursor: null,
    };
    vi.spyOn(comicDramaApi, "listDramas").mockResolvedValue(tree);
    vi.spyOn(api, "getProductLinks").mockResolvedValue({
      globle: 0, webUrl: "https://example.com", tokenhubUrl: "https://example.com",
    } as never);

    const open = vi.fn();
    const onAddEpisode = vi.fn();
    const host = await mount(createElement(SeriesHistory, {
      busy: false,
      focusDramaId: dramaId,
      open,
      derive: vi.fn(async () => true),
      change: vi.fn(async () => true),
      onCreateDrama: vi.fn(),
      onEditDrama: vi.fn(),
      onAddEpisode,
      onDramaChange: vi.fn(async () => true),
    }), "zh");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const group = host.querySelector(".comic-drama-group");
    expect(group?.getAttribute("data-current")).toBe("true");
    expect(group?.textContent).toContain("整部剧集");
    expect(group?.textContent).toContain("雨夜便利店");
    expect(group?.textContent).toContain("共 2 集");
    expect(group?.textContent).toContain("第 1 集");
    expect(group?.textContent).toContain("第一夜：风铃");
    expect(group?.textContent).toContain("第 2 集");
    expect(group?.textContent).toContain("第二夜：热咖啡");
  });
});
