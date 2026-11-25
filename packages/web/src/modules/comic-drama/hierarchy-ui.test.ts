// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comicSystemDictionary,
  type ComicDramaClip, type ComicDramaEpisodeBrief, type ComicDramaSeries, type ComicDramaTreeListing, type ComicDramaView,
} from "@lot-agent/core/comic-drama";
import { api } from "../../api/client.js";
import { LanguageProvider } from "../../i18n/index.js";
import { LOCALE_STORAGE_KEY } from "../../i18n/locale.js";
import { ComicClipOriginBadge, ComicWorkspaceHierarchyBar } from "./ComicHierarchyBar.js";
import { CastPanel } from "./CastPanel.js";
import { ComicImageGeneration } from "./ComicImageGeneration.js";
import { DramaDialog } from "./DramaDialog.js";
import { DramaHub } from "./DramaHub.js";
import { SeriesDialog } from "./SeriesDialog.js";
import { SeriesHistory } from "./SeriesHistory.js";
import { Storyboard } from "./Storyboard.js";
import { comicDramaApi } from "./api.js";
import { comicGenerationApi } from "./generation-api.js";
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
        outline: "全剧大纲",
        scriptContent: "总剧本",
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
        castCount: 2,
        hasOutline: true,
        hasScript: true,
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

  it("renders DramaHub 4-step preparation (outline -> cast -> script -> episodes) and clean episode creation flow", async () => {
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async (domain) => [
      ...(comicSystemDictionary[domain] ?? []),
    ] as never);
    vi.spyOn(comicLibraryApi, "settings").mockResolvedValue({
      preferences: { defaultVideoModel: "doubao-seedance-2-0", defaultImageModel: null },
      stylePresets: [],
    });
    vi.spyOn(comicDramaApi, "listDramas").mockResolvedValue({ dramas: [], nextCursor: null });
    vi.spyOn(comicDramaApi, "dramaCast").mockResolvedValue({ cast: [], dramaRevision: 1 });

    // 1. DramaDialog creates a new drama cleanly without episode fields
    const saveDrama = vi.fn(async () => true);
    const dialogHost = await mount(createElement(DramaDialog, {
      models: [{ id: "doubao-seedance-2-0", name: "Seedance 2.0" }],
      close: vi.fn(),
      save: saveDrama,
      error: null,
    }), "zh");
    expect(dialogHost.textContent).toContain("新建新剧");
    expect(dialogHost.textContent).not.toContain("所属整部剧集");
    expect(dialogHost.textContent).not.toContain("第 1 集名称");

    act(() => root?.unmount());
    document.body.replaceChildren();

    // 2. DramaHub guides outline -> cast -> script -> Episode 1
    const dramaId = uuid(100);
    const view: ComicDramaView = {
      drama: {
        id: dramaId,
        title: "雨夜便利店",
        synopsis: "都市奇幻短剧",
        outline: "全剧共 10 集，围绕雨夜便利店的来客展开。",
        scriptContent: "【第 1 集】雨夜风铃响起。",
        styleKey: "thick_painting",
        aspectRatio: "9:16",
        videoModel: "doubao-seedance-2-0",
        revision: 1,
        archivedAt: null,
      },
      episodes: [],
      cast: [],
    };
    const onAddEpisode = vi.fn();
    const hubHost = await mount(createElement(DramaHub, {
      view,
      busy: false,
      onUpdated: vi.fn(),
      onReload: vi.fn(async () => {}),
      onEditDrama: vi.fn(),
      onAddEpisode,
      onOpenEpisode: vi.fn(),
      onDeriveEpisode: vi.fn(async () => true),
      onChangeEpisode: vi.fn(async () => true),
      onOpenHistory: vi.fn(),
      onOpenCharacters: vi.fn(),
    }), "zh");

    expect(hubHost.textContent).toContain("《雨夜便利店》");
    expect(hubHost.textContent).toContain("全剧大纲");
    expect(hubHost.textContent).toContain("创建第 1 集");

    const epStepBtn = Array.from(hubHost.querySelectorAll("nav button")).find(btn => btn.textContent?.includes("分集"));
    expect(epStepBtn).toBeTruthy();
    act(() => { epStepBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(hubHost.textContent).toContain("从第 1 集开始创建分集");

    act(() => root?.unmount());
    document.body.replaceChildren();

    // 3. SeriesDialog in addEpisode mode focuses strictly on Episode 1 with parent drama pill
    const epHost = await mount(createElement(SeriesDialog, {
      presetDrama: {
        id: dramaId,
        title: "雨夜便利店",
        styleKey: "thick_painting",
        aspectRatio: "9:16",
        videoModel: "doubao-seedance-2-0",
        nextEpisodeNo: 1,
        castCount: 3,
        episodes: [],
      },
      models: [{ id: "doubao-seedance-2-0", name: "Seedance 2.0" }],
      close: vi.fn(),
      save: vi.fn(async () => true),
      error: null,
    }), "zh");
    expect(epHost.textContent).toContain("创建第 1 集");
    expect(epHost.textContent).toContain("《雨夜便利店》");
    expect(epHost.textContent).toContain("自动带入全剧角色（3 名）");
    expect(epHost.textContent).not.toContain("新建整部剧集");
  });

  it("supports DramaHub AI outline polish, CastPanel quick character creation with drama attribution, AI script modal, and jump-to-task focus", async () => {
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async (domain) => [
      ...(comicSystemDictionary[domain] ?? []),
    ] as never);
    vi.spyOn(comicDramaApi, "listDramaOptions").mockResolvedValue([
      { id: uuid(100), title: "雨夜便利店", archived: false },
      { id: uuid(200), title: "长安雨夜", archived: false },
    ]);
    const polishSpy = vi.spyOn(comicDramaApi, "polishDramaOutline").mockResolvedValue({
      outline: "润色后的十集大纲：暴雨夜的便利店串联十位夜归人的执念与救赎。",
      modelId: "deepseek-v4.1-flash",
    });
    const genScriptSpy = vi.spyOn(comicDramaApi, "generateDramaScript").mockResolvedValue({
      script: "【第 1 集：风铃】\n场景：深夜便利店。",
      truncated: false,
      modelId: "deepseek-v4.1-flash",
    });

    const dramaId = uuid(100);
    const view: ComicDramaView = {
      drama: {
        id: dramaId,
        title: "雨夜便利店",
        synopsis: "都市奇幻短剧",
        outline: "女孩失恋后来到深夜便利店。",
        scriptContent: "",
        styleKey: "thick_painting",
        aspectRatio: "9:16",
        videoModel: "doubao-seedance-2-0",
        revision: 1,
        archivedAt: null,
      },
      episodes: [],
      cast: [{
        snapshot: {
          schemaVersion: 1,
          characterId: uuid(301),
          name: "沈青",
          aliases: [],
          age: "26",
          personality: "冷静",
          appearance: "风衣",
          roleKey: "lead",
          outfitId: uuid(401),
          outfitName: "雨夜风衣",
          assets: [],
        },
        archived: false,
        hasUpdates: false,
        originDramaId: uuid(200),
        originDramaTitle: "长安雨夜",
      }],
    };
    vi.spyOn(comicDramaApi, "dramaCast").mockResolvedValue({ cast: view.cast, dramaRevision: 1 });

    const hubHost = await mount(createElement(DramaHub, {
      view,
      busy: false,
      onUpdated: vi.fn(),
      onReload: vi.fn(async () => {}),
      onEditDrama: vi.fn(),
      onAddEpisode: vi.fn(),
      onOpenEpisode: vi.fn(),
      onDeriveEpisode: vi.fn(async () => true),
      onChangeEpisode: vi.fn(async () => true),
      onOpenHistory: vi.fn(),
      onOpenCharacters: vi.fn(),
    }), "zh");

    // 1. Step 1: AI polish button below outline -> shows preview -> adopt updates textarea
    const polishBtn = Array.from(hubHost.querySelectorAll("button")).find(btn => btn.textContent?.includes("AI 润色"));
    expect(polishBtn).toBeTruthy();
    await act(async () => {
      polishBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(polishSpy).toHaveBeenCalledWith(dramaId, { outline: "女孩失恋后来到深夜便利店。", language: "zh" }, expect.any(AbortSignal));
    expect(hubHost.textContent).toContain("AI 润色建议");
    const adoptPolishBtn = Array.from(hubHost.querySelectorAll("button")).find(btn => btn.textContent?.includes("采用润色结果"));
    act(() => { adoptPolishBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const outlineArea = hubHost.querySelector('textarea[aria-label="全剧大纲"]') as HTMLTextAreaElement | null;
    expect(outlineArea?.value).toContain("润色后的十集大纲");

    // 2. Step 2: CastPanel shows cross-drama origin badge & "+ 新增角色" button with current drama preselected
    const castStepBtn = Array.from(hubHost.querySelectorAll("nav button")).find(btn => btn.textContent?.includes("角色"));
    await act(async () => {
      castStepBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(hubHost.textContent).toContain("跨剧 · 《长安雨夜》");

    const createCharSpy = vi.spyOn(comicLibraryApi, "createCharacter").mockResolvedValue({ id: uuid(302) });
    const createOutfitSpy = vi.spyOn(comicLibraryApi, "outfit").mockResolvedValue({ id: uuid(402), name: "默认造型" });
    const changeCastSpy = vi.fn(async () => true);

    act(() => root?.unmount());
    document.body.replaceChildren();
    const castHost = await mount(createElement(CastPanel, {
      scope: "drama",
      seriesId: dramaId,
      dramaId,
      dramaTitle: "雨夜便利店",
      revision: 1,
      cast: [],
      disabled: false,
      change: changeCastSpy,
      onOpenLibrary: vi.fn(),
    }), "zh");

    const newCharBtn = Array.from(castHost.querySelectorAll("button")).find(btn => btn.textContent?.includes("新增角色"));
    expect(newCharBtn).toBeTruthy();
    await act(async () => {
      newCharBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const dramaSelect = castHost.querySelector('select[name="dramaId"]') as HTMLSelectElement | null;
    expect(dramaSelect?.value).toBe(dramaId);
    const charNameInput = castHost.querySelector('input[name="name"]') as HTMLInputElement | null;
    if (charNameInput) charNameInput.value = "林夏";
    const charForm = castHost.querySelector("dialog form") as HTMLFormElement | null;
    await act(async () => {
      charForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createCharSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "林夏", dramaId }));
    expect(createOutfitSpy).toHaveBeenCalledWith(uuid(302), "默认造型");
    expect(changeCastSpy).toHaveBeenCalledWith({ action: "add", characterId: uuid(302), outfitId: uuid(402) });

    // 3. Step 3: DramaHub "AI 生成剧本" opens dialog with episodeCount & notes and populates script
    act(() => root?.unmount());
    document.body.replaceChildren();
    const scriptHubHost = await mount(createElement(DramaHub, {
      view,
      busy: false,
      initialTab: "script",
      onUpdated: vi.fn(),
      onReload: vi.fn(async () => {}),
      onEditDrama: vi.fn(),
      onAddEpisode: vi.fn(),
      onOpenEpisode: vi.fn(),
      onDeriveEpisode: vi.fn(async () => true),
      onChangeEpisode: vi.fn(async () => true),
      onOpenHistory: vi.fn(),
      onOpenCharacters: vi.fn(),
    }), "zh");
    const aiScriptBtn = Array.from(scriptHubHost.querySelectorAll("button")).find(btn => btn.textContent?.includes("AI 生成剧本"));
    expect(aiScriptBtn).toBeTruthy();
    act(() => { aiScriptBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const epCountInput = scriptHubHost.querySelector('input[name="episodeCount"]') as HTMLInputElement | null;
    const notesInput = scriptHubHost.querySelector('textarea[name="notes"]') as HTMLTextAreaElement | null;
    expect(epCountInput).toBeTruthy();
    expect(notesInput).toBeTruthy();
    if (epCountInput) epCountInput.value = "8";
    if (notesInput) notesInput.value = "每集结尾加悬念";
    const genForm = scriptHubHost.querySelector("dialog form") as HTMLFormElement | null;
    await act(async () => {
      genForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(genScriptSpy).toHaveBeenCalledWith(dramaId, {
      episodeCount: 8,
      notes: "每集结尾加悬念",
      outline: "女孩失恋后来到深夜便利店。",
      language: "zh",
    }, expect.any(AbortSignal));
    const scriptArea = scriptHubHost.querySelector('textarea[aria-label="全剧剧本"]') as HTMLTextAreaElement | null;
    expect(scriptArea?.value).toContain("【第 1 集：风铃】");

    // 4. Step 4: ComicImageGeneration renders jump button beside "生成中" and focuses generation results below
    act(() => root?.unmount());
    document.body.replaceChildren();
    vi.spyOn(comicGenerationApi, "videos").mockResolvedValue([]);
    vi.spyOn(comicGenerationApi, "keyframes").mockResolvedValue({ takes: [], approvedTakeId: null, approvedMediaId: null, selectionRevision: 1 });
    const selectClip = vi.fn();
    const clipA: ComicDramaClip = {
      id: uuid(501),
      revision: 1,
      selectionRevision: 1,
      ordinal: 1,
      draft: {
        schemaVersion: 1, durationMs: 5000, scene: "便利店内",
        shots: [{ id: uuid(601), framingKey: "medium", movementKey: "fixed", description: "镜1", durationShare: 100 }],
        lines: [],
      },
      progress: {
        keyframeState: "ready", keyframeMediaId: uuid(701), keyframeApproved: true, keyframeStale: false,
        videoState: "running", videoTakeCount: 1, adoptedVideoTakeId: null, adoptedVideoVersion: null,
        adoptedVideoMediaId: null, adoptedStale: false, castSnapshotStale: false,
      },
    };
    const genHost = await mount(createElement(ComicImageGeneration, {
      detail: {
        series: {
          id: uuid(11), dramaId, parentId: null, title: "第一集", logline: "", seriesGroup: "雨夜便利店",
          episodeNo: 1, styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "doubao-seedance-2-0",
          revision: 1, archivedAt: null,
        },
        clips: [clipA],
        script: null,
        cast: [],
      },
      selected: clipA.id,
      select: selectClip,
      getSaved: async () => null,
      disabled: false,
      initialMode: "from_keyframe",
      choose: vi.fn(),
      editClip: vi.fn(),
    }), "zh");

    expect(genHost.textContent).toContain("当前有 1 个分镜正在生成中，请稍候查看进度。");
    const jumpBtn = genHost.querySelector(".comic-jump-task-btn") as HTMLButtonElement | null;
    expect(jumpBtn).toBeTruthy();
    const resultsEl = genHost.querySelector(".comic-generation-results") as HTMLDivElement | null;
    const scrollMock = vi.fn();
    const focusMock = vi.fn();
    if (resultsEl) {
      resultsEl.scrollIntoView = scrollMock;
      resultsEl.focus = focusMock;
    }
    act(() => { jumpBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    expect(scrollMock).toHaveBeenCalled();
    expect(focusMock).toHaveBeenCalled();
  });
});
