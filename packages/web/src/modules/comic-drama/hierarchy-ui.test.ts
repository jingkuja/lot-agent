// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comicSystemDictionary,
  type ComicDirectorProposal, type ComicDramaClip, type ComicDramaDetail, type ComicDramaEpisodeBrief, type ComicDramaSeries,
  type ComicDramaTreeListing, type ComicDramaView,
} from "@lot-agent/core/comic-drama";
import { api, ApiClientError } from "../../api/client.js";
import { LanguageProvider } from "../../i18n/index.js";
import { LOCALE_STORAGE_KEY } from "../../i18n/locale.js";
import { ComicClipOriginBadge, ComicWorkspaceHierarchyBar } from "./ComicHierarchyBar.js";
import { CastPanel } from "./CastPanel.js";
import { CharacterLibrary } from "./CharacterLibrary.js";
import { ComicDramaWorkspace } from "./ComicDramaWorkspace.js";
import { ComicImageGeneration } from "./ComicImageGeneration.js";
import { DramaDialog } from "./DramaDialog.js";
import { DramaHub } from "./DramaHub.js";
import { MaterialLibrary } from "./MaterialLibrary.js";
import { useGenerationHistory } from "./GenerationHistory.js";
import { SeriesDialog } from "./SeriesDialog.js";
import { SeriesHistory } from "./SeriesHistory.js";
import { Storyboard } from "./Storyboard.js";
import { comicDramaApi } from "./api.js";
import { comicDirectorApi } from "./director-api.js";
import { comicEditApi } from "./edit-api.js";
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

it.each([
  ["zh", "编辑角色", "取消", "绑定角色音色", "AI 生成配音音色", "生成中…", "音色审核中", "可用于配音"],
  ["en", "Edit character", "Cancel", "Bind character voice", "Generate AI voice", "Generating…", "Voice under review", "Ready for dubbing"],
] as const)("generates and binds a voice from the saved profile in the %s voice dialog", async (locale, edit, cancel, bind, action, working, reviewing, ready) => {
  vi.useFakeTimers();
  try {
    vi.spyOn(comicDramaApi, "listDramaOptions").mockResolvedValue([]);
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async domain => [...comicSystemDictionary[domain]]);
    const characterId = uuid(37);
    vi.spyOn(comicLibraryApi, "character").mockResolvedValue({
      id: characterId, name: "Lily", gender: "female", age: "22", aliases: [], tags: [], roleKey: "lead",
      appearance: "Long hair", personality: "Reserved", archived: false, cover: null, outfits: [], assets: [],
    });
    vi.spyOn(comicGenerationApi, "characterTakes").mockResolvedValue([]);
    vi.spyOn(comicEditApi, "voice").mockResolvedValue({ binding: { kind: "none" }, presets: [], clonesEnabled: false, clones: [] });
    const save = vi.spyOn(comicEditApi, "bindVoice").mockResolvedValue({ ok: true });
    const voice = { id: uuid(38), name: "Lily", status: "DEPLOYING" as const, voiceId: "provider-voice-id", previewMediaId: null };
    let finish!: (value: typeof voice) => void;
    const generate = vi.spyOn(comicLibraryApi, "designCharacterVoice").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const refresh = vi.spyOn(comicLibraryApi, "refreshCharacterVoice").mockResolvedValue({ ...voice, status: "OK" });
    const host = await mount(createElement(CharacterLibrary, { characterId, open: vi.fn() }), locale);
    const buttonFor = (label: string) => [...host.querySelectorAll("button")].find(item => item.textContent === label)!;
    await act(async () => { buttonFor(edit).click(); });
    const editDialog = host.querySelector("dialog")!;
    expect(editDialog.querySelector<HTMLSelectElement>('select[name="gender"]')?.value).toBe("female");
    expect(editDialog.textContent).not.toContain(action);
    await act(async () => { buttonFor(cancel).click(); });
    await act(async () => { buttonFor(bind).click(); });
    const dialog = host.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe(bind);
    const form = dialog.querySelector("form")!;
    const submit = dialog.querySelector<HTMLButtonElement>("button.primary")!;
    const button = buttonFor(action);
    await act(async () => { button.click(); });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      language: locale, character: expect.objectContaining({ name: "Lily", gender: "female", age: "22", personality: "Reserved" }),
    }), expect.any(AbortSignal));
    expect(button.textContent).toBe(working);
    expect(submit.disabled).toBe(true);
    await act(async () => { finish(voice); });
    expect(dialog.textContent).toContain(voice.voiceId);
    expect(dialog.textContent).toContain(reviewing);
    expect(submit.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(refresh).toHaveBeenCalledWith(voice.id, expect.any(AbortSignal));
    expect(dialog.textContent).toContain(ready);
    expect(dialog.querySelector<HTMLSelectElement>("select[required]")?.value).toBe(voice.id);
    expect(submit.disabled).toBe(false);
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(save).toHaveBeenCalledWith(characterId, { kind: "library", voiceId: voice.id }, expect.any(AbortSignal));
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["zh", "人物配音", "创建音色", "使用参考音效", "上传本人录音"],
  ["en", "Character voices", "Create voice", "Use reference audio", "Upload a recording of my voice"],
] as const)("opens the third %s material tab and toggles the own-voice sample form", async (locale, tab, action, ownVoiceLabel, sample) => {
  vi.spyOn(comicLibraryApi, "materials").mockResolvedValue({ entries: [], more: false });
  vi.spyOn(comicGenerationApi, "materialTakes").mockResolvedValue([]);
  vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async domain => [...comicSystemDictionary[domain]]);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ entries: [], more: false, enabled: true }));
  vi.stubGlobal("fetch", fetcher);
  const host = await mount(createElement(MaterialLibrary), locale);
  const button = (label: string) => [...host.querySelectorAll("button")].find(element => element.textContent?.includes(label))!;
  expect(host.querySelectorAll("nav.comic-steps button")[2]).toBe(button(tab));
  await act(async () => { button(tab).click(); });
  expect(button(tab).getAttribute("aria-pressed")).toBe("true");
  expect(fetcher.mock.calls[0][0]).toContain("/comic-drama/voices?");
  await act(async () => { button(action).click(); });
  const dialog = host.querySelector("dialog")!;
  const mode = dialog.querySelector<HTMLInputElement>('input[type="checkbox"][name="useOwnVoice"]')!;
  expect(mode.labels?.[0]?.textContent?.trim()).toBe(ownVoiceLabel);
  expect(mode.checked).toBe(false);
  expect(dialog.querySelector('select[name="gender"]')).not.toBeNull();
  expect(dialog.querySelector('input[name="sample"]')).toBeNull();
  await act(async () => { mode.click(); });
  expect(mode.checked).toBe(true);
  expect(dialog.textContent).toContain(sample);
  expect(dialog.querySelector('select[name="gender"]')).toBeNull();
  const consent = dialog.querySelector<HTMLInputElement>('input[name="ownVoice"]')!;
  expect(consent.required).toBe(true);
  expect(consent.checked).toBe(false);
  await act(async () => { mode.click(); });
  expect(mode.checked).toBe(false);
  expect(dialog.querySelector('select[name="gender"]')).not.toBeNull();
  expect(dialog.querySelector('input[name="sample"]')).toBeNull();
});

it("opens the full description for the selected voice and closes the dialog", async () => {
  vi.spyOn(comicLibraryApi, "materials").mockResolvedValue({ entries: [], more: false });
  vi.spyOn(comicGenerationApi, "materialTakes").mockResolvedValue([]);
  vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async domain => [...comicSystemDictionary[domain]]);
  const voicePrompt = "偏高音区，语速适中，吐字清晰。\n" + "补充音色描述。".repeat(20);
  const entries = [
    { id: uuid(21), name: "路人女童", kind: "design", status: "DEPLOYING", voicePrompt },
    { id: uuid(22), name: "路人大叔", kind: "design", status: "DEPLOYING", voicePrompt: "古代路人大叔" },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries, more: false, enabled: true })));
  const host = await mount(createElement(MaterialLibrary));
  const voiceTab = [...host.querySelectorAll<HTMLButtonElement>("nav button")].find(button => button.textContent === "人物配音")!;
  await act(async () => { voiceTab.click(); });
  const more = host.querySelector<HTMLButtonElement>('button[aria-label="更多 · 路人女童"]')!;
  expect(more.textContent).toBe("更多");
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => { more.click(); });
  const dialog = host.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("h2")?.textContent).toBe("路人女童");
  expect(dialog.querySelector("p")?.textContent).toBe(voicePrompt);
  await act(async () => { dialog.querySelector("button")!.click(); });
  expect(host.querySelector("dialog")).toBeNull();
});

it.each([
  ["zh", "人物配音", "创建音色", "女声，青年感，偏低音区，语速偏慢"],
  ["en", "Character voices", "Create voice", "Female voice, Young adult, Slightly low pitch, Slightly slow pace"],
] as const)("submits selected %s design traits with the preview settings and no extra description", async (locale, tab, action, voicePrompt) => {
  vi.spyOn(comicLibraryApi, "materials").mockResolvedValue({ entries: [], more: false });
  vi.spyOn(comicGenerationApi, "materialTakes").mockResolvedValue([]);
  vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async domain => [...comicSystemDictionary[domain]]);
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
    ? Response.json({ status: "DEPLOYING" }) : Response.json({ entries: [], more: false, enabled: true }));
  vi.stubGlobal("fetch", fetcher);
  const host = await mount(createElement(MaterialLibrary), locale);
  const button = (label: string) => [...host.querySelectorAll("button")].find(element => element.textContent?.includes(label))!;
  await act(async () => { button(tab).click(); });
  await act(async () => { button(action).click(); });
  const dialog = host.querySelector("dialog")!;
  dialog.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Detective";
  for (const [key, value] of Object.entries({
    gender: "女声", age: "青年感", pitch: "偏低音区", pace: "语速偏慢", sampleRate: "48000", previewFormat: "mp3",
  })) {
    dialog.querySelector<HTMLSelectElement>(`select[name="${key}"]`)!.value = value;
  }
  await act(async () => { dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  const body = fetcher.mock.calls.find(([, init]) => init.method === "POST")?.[1].body as FormData | undefined;
  expect(JSON.parse(String(body?.get("fields")))).toMatchObject({
    kind: "design", language: locale, voicePrompt, sampleRate: 48000, previewFormat: "mp3",
  });
});

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

  it("auto-fills SeriesDialog and DramaHub Step 4 from generated multi-episode master script", async () => {
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async (domain) => [
      ...(comicSystemDictionary[domain] ?? []),
    ] as never);
    vi.spyOn(comicLibraryApi, "settings").mockResolvedValue({
      preferences: { defaultVideoModel: "doubao-seedance-2-0", defaultImageModel: null },
      stylePresets: [],
    });
    vi.spyOn(comicDramaApi, "listDramas").mockResolvedValue({ dramas: [], nextCursor: null });

    const dramaId = uuid(101);
    const masterScript = [
      "【第 1 集：雨夜里的过期快乐】",
      "【00:00-00:06 | 写字楼·深夜】",
      "冷白灯下，丽丽独自敲键盘。",
      "",
      "【第 2 集：热咖啡】",
      "【00:00-00:08 | 便利店收银台】",
      "小田递出一杯热拿铁。",
    ].join("\n");

    const onAddEpisode = vi.fn();
    const hubView: ComicDramaView = {
      drama: {
        id: dramaId,
        title: "雨夜便利店",
        synopsis: "都市短剧",
        outline: "全剧共 2 集。",
        scriptContent: masterScript,
        styleKey: "thick_painting",
        aspectRatio: "9:16",
        videoModel: "doubao-seedance-2-0",
        revision: 2,
        archivedAt: null,
      },
      episodes: [makeEpisodes(dramaId)[0]!],
      cast: [],
    };

    const hubHost = await mount(createElement(DramaHub, {
      view: hubView,
      busy: false,
      initialTab: "episodes",
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

    expect(hubHost.textContent).toContain("识别 2 集");
    expect(hubHost.textContent).toContain("已从全剧剧本识别 1 集待创建分集");
    expect(hubHost.textContent).toContain("热咖啡");
    expect(hubHost.textContent).toContain("带入本集内容并创建");

    const prefillBtn = Array.from(hubHost.querySelectorAll("button")).find(btn => btn.textContent?.includes("带入本集内容并创建"));
    act(() => { prefillBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onAddEpisode).toHaveBeenCalledWith({ episodeNo: 2, scriptContent: masterScript });

    act(() => root?.unmount());
    document.body.replaceChildren();

    const save = vi.fn(async () => true);
    const dlgHost = await mount(createElement(SeriesDialog, {
      presetDrama: {
        id: dramaId,
        title: "雨夜便利店",
        styleKey: "thick_painting",
        aspectRatio: "9:16",
        videoModel: "doubao-seedance-2-0",
        nextEpisodeNo: 1,
        castCount: 2,
        episodes: [],
        scriptContent: masterScript,
      },
      models: [{ id: "doubao-seedance-2-0", name: "Seedance 2.0" }],
      close: vi.fn(),
      save,
      error: null,
    }), "zh");

    const titleInput = dlgHost.querySelector('input[name="title"]') as HTMLInputElement;
    const epNoInput = dlgHost.querySelector('input[name="episodeNo"]') as HTMLInputElement;
    const scriptArea = dlgHost.querySelector('textarea[name="initialScript"]') as HTMLTextAreaElement;
    expect(titleInput.value).toBe("雨夜里的过期快乐");
    expect(scriptArea.value).toContain("【第 1 集：雨夜里的过期快乐】");
    expect(scriptArea.value).not.toContain("【第 2 集：热咖啡】");
    expect(dlgHost.textContent).toContain("已从全剧剧本自动带入第 1 集内容，可直接修改");

    // Switch episodeNo to 2 while untouched -> auto-switches to Episode 2 title & script
    const setInputValue = (el: HTMLInputElement | HTMLTextAreaElement, next: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await act(async () => {
      setInputValue(epNoInput, "2");
      await Promise.resolve();
    });
    expect(titleInput.value).toBe("热咖啡");
    expect(scriptArea.value).toContain("【第 2 集：热咖啡】");
    expect(scriptArea.value).not.toContain("【第 1 集：雨夜里的过期快乐】");

    // User modifies script manually -> switching episodeNo back to 1 preserves edit and shows restore button
    await act(async () => {
      setInputValue(scriptArea, "用户自定义修改的第 2 集剧本");
      await Promise.resolve();
    });
    expect(dlgHost.textContent).toContain("恢复第 2 集原文");

    await act(async () => {
      setInputValue(epNoInput, "1");
      await Promise.resolve();
    });
    expect(scriptArea.value).toBe("用户自定义修改的第 2 集剧本");

    // Clearing script submits explicit empty string initialScript: ""
    await act(async () => {
      setInputValue(scriptArea, "");
      await Promise.resolve();
    });
    const form = dlgHost.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ episodeNo: 1, initialScript: "" }),
      undefined,
    );

    // Verify English rendering
    act(() => root?.unmount());
    document.body.replaceChildren();
    const enHost = await mount(createElement(DramaHub, {
      view: hubView,
      busy: false,
      initialTab: "episodes",
      onUpdated: vi.fn(),
      onReload: vi.fn(async () => {}),
      onEditDrama: vi.fn(),
      onAddEpisode: vi.fn(),
      onOpenEpisode: vi.fn(),
      onDeriveEpisode: vi.fn(async () => true),
      onChangeEpisode: vi.fn(async () => true),
      onOpenHistory: vi.fn(),
      onOpenCharacters: vi.fn(),
    }), "en");
    expect(enHost.textContent).toContain("1 pending episode(s) detected from drama script");
    expect(enHost.textContent).toContain("Pre-fill & create episode");
  });

  it("renders Storyboard AI generation CTAs for empty clips, blank clips, and inline proposal preview", async () => {
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async (domain) => [
      ...(comicSystemDictionary[domain] ?? []),
    ] as never);
    const dramaId = uuid(1);
    const series: ComicDramaSeries = {
      id: uuid(11),
      dramaId,
      parentId: null,
      title: "雨夜里的过期快乐",
      logline: "",
      seriesGroup: "雨夜便利店",
      episodeNo: 1,
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: "doubao-seedance-2-5",
      revision: 1,
      archivedAt: null,
    };
    const onGenerateFromScript = vi.fn();
    const emptyHost = await mount(createElement(Storyboard, {
      dramaTitle: "雨夜便利店",
      series,
      clips: [],
      cast: [],
      drafts: {},
      disabled: false,
      locked: false,
      selected: null,
      select: vi.fn(),
      edit: vi.fn(),
      add: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
      hasScript: true,
      scriptCharCount: 240,
      onGenerateFromScript,
    }), "zh");
    expect(emptyHost.textContent).toContain("从本集剧本一键生成分镜");
    const emptyAiBtn = Array.from(emptyHost.querySelectorAll("button")).find(
      btn => btn.textContent?.includes("AI 从本集剧本生成分镜"),
    );
    act(() => { emptyAiBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onGenerateFromScript).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    document.body.replaceChildren();

    const blankClip: ComicDramaClip = {
      id: uuid(301),
      revision: 1,
      selectionRevision: 1,
      ordinal: 1,
      draft: { schemaVersion: 1, durationMs: 6000, scene: "", shots: [], lines: [] },
    };
    const blankHost = await mount(createElement(Storyboard, {
      dramaTitle: "雨夜便利店",
      series,
      clips: [blankClip],
      cast: [],
      drafts: { [blankClip.id]: { draft: blankClip.draft } },
      disabled: false,
      locked: false,
      selected: blankClip.id,
      select: vi.fn(),
      edit: vi.fn(),
      add: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
      hasScript: true,
      scriptCharCount: 240,
      onGenerateFromScript,
    }), "zh");
    expect(blankHost.textContent).toContain("检测到本集已有剧本与选角，当前分镜尚未填写");
    const blankAiBtn = Array.from(blankHost.querySelectorAll("button")).find(
      btn => btn.textContent?.includes("AI 一键带入剧本生成分镜"),
    );
    act(() => { blankAiBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onGenerateFromScript).toHaveBeenCalledTimes(2);

    act(() => root?.unmount());
    document.body.replaceChildren();

    const filledClip: ComicDramaClip = {
      ...blankClip,
      draft: {
        schemaVersion: 1,
        durationMs: 5000,
        scene: "已有分镜",
        shots: [{ id: uuid(302), framingKey: "medium", movementKey: "fixed", description: "原镜头", durationShare: 100 }],
        lines: [],
      },
    };
    const previewProposal: ComicDirectorProposal = {
      id: uuid(401),
      conversationId: uuid(402),
      baseRevision: 1,
      createdAt: "2026-11-26T00:00:00.000Z",
      input: { requestId: uuid(403), expectedRevision: 1, mode: "paste", language: "zh", text: "剧本", action: "breakdown" },
      original: "剧本",
      status: "ready",
      appliedRevision: null,
      proposal: {
        script: "",
        roles: [],
        clips: [{
          schemaVersion: 1,
          durationMs: 6000,
          scene: "写字楼深夜",
          shots: [{ id: uuid(404), framingKey: "close_up", movementKey: "push", description: "丽丽敲键盘", durationShare: 100 }],
          lines: [{ id: uuid(405), speaker: "丽丽", text: "方案又被驳回了。", emotionKey: "sad", speed: 1 }],
        }],
      },
    };
    const onApplyBreakdownPreview = vi.fn();
    const onDismissBreakdownPreview = vi.fn();
    const previewHost = await mount(createElement(Storyboard, {
      dramaTitle: "雨夜便利店",
      series,
      clips: [filledClip],
      cast: [],
      drafts: { [filledClip.id]: { draft: filledClip.draft } },
      disabled: false,
      locked: false,
      selected: filledClip.id,
      select: vi.fn(),
      edit: vi.fn(),
      add: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
      hasScript: true,
      breakdownProposal: previewProposal,
      onGenerateFromScript,
      onApplyBreakdownPreview,
      onDismissBreakdownPreview,
    }), "zh");
    expect(previewHost.textContent).toContain("写字楼深夜");
    const replaceBtn = Array.from(previewHost.querySelectorAll("button")).find(btn => btn.textContent?.includes("替换现有分镜"));
    const dismissBtn = Array.from(previewHost.querySelectorAll("button")).find(btn => btn.textContent?.includes("放弃"));
    act(() => { replaceBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onApplyBreakdownPreview).toHaveBeenCalledWith("replace");
    act(() => { dismissBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onDismissBreakdownPreview).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    document.body.replaceChildren();
    const enHost = await mount(createElement(Storyboard, {
      dramaTitle: "Rainy Night Store",
      series,
      clips: [],
      cast: [],
      drafts: {},
      disabled: false,
      locked: false,
      selected: null,
      select: vi.fn(),
      edit: vi.fn(),
      add: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
      hasScript: true,
      scriptCharCount: 240,
      onGenerateFromScript,
    }), "en");
    expect(enHost.textContent).toContain("Generate storyboard from episode script");
    expect(enHost.textContent).toContain("AI Generate from Episode Script");
  });

  it("shows Storyboard issue popover on hover in zh and en and dismisses on Escape", async () => {
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async (domain) => [
      ...(comicSystemDictionary[domain] ?? []),
    ] as never);
    const dramaId = uuid(1);
    const series: ComicDramaSeries = {
      id: uuid(11),
      dramaId,
      parentId: null,
      title: "第一夜",
      logline: "",
      seriesGroup: "雨夜便利店",
      episodeNo: 1,
      styleKey: "thick_painting",
      aspectRatio: "9:16",
      videoModel: "doubao-seedance-2-5",
      revision: 1,
      archivedAt: null,
    };
    const issueClip: ComicDramaClip = {
      id: uuid(610),
      revision: 1,
      selectionRevision: 1,
      ordinal: 1,
      draft: {
        schemaVersion: 1,
        durationMs: 4000,
        scene: "收银台",
        shots: [{ id: uuid(611), framingKey: "medium", movementKey: "fixed", description: "对峙", durationShare: 100 }],
        lines: [{ id: uuid(612), speaker: "林夏", text: "你好", emotionKey: null, speed: 1 }],
      },
    };
    const hostZh = await mount(createElement(Storyboard, {
      dramaTitle: "雨夜便利店",
      series,
      clips: [issueClip],
      cast: [],
      drafts: { [issueClip.id]: { draft: issueClip.draft } },
      disabled: false,
      locked: false,
      selected: issueClip.id,
      select: vi.fn(),
      edit: vi.fn(),
      add: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
    }), "zh");
    const triggerZh = hostZh.querySelector(".comic-pill-trigger");
    expect(triggerZh?.textContent).toBe("1 项提醒");
    act(() => { triggerZh?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const tooltipZh = document.body.querySelector('[role="tooltip"]');
    expect(tooltipZh?.textContent).toContain("分镜 1 · 1 项提醒");
    expect(tooltipZh?.textContent).toContain("林夏");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    act(() => root?.unmount());
    document.body.replaceChildren();
    const hostEn = await mount(createElement(Storyboard, {
      dramaTitle: "Rainy Night Store",
      series,
      clips: [issueClip],
      cast: [],
      drafts: { [issueClip.id]: { draft: issueClip.draft } },
      disabled: false,
      locked: false,
      selected: issueClip.id,
      select: vi.fn(),
      edit: vi.fn(),
      add: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
    }), "en");
    const triggerEn = hostEn.querySelector(".comic-pill-trigger");
    expect(triggerEn?.textContent).toBe("1 alerts");
    act(() => { triggerEn?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const tooltipEn = document.body.querySelector('[role="tooltip"]');
    expect(tooltipEn?.textContent).toContain("Clip 1 · 1 alert(s)");
  });

  it("guides users from unconfirmed from_keyframe quotes to keyframe approval or direct references", async () => {
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(() => {});
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(() => {});
    vi.spyOn(comicGenerationApi, "videos").mockResolvedValue([]);
    vi.spyOn(comicGenerationApi, "keyframes").mockResolvedValue({
      takes: [], approvedTakeId: null, approvedMediaId: null, selectionRevision: 1,
    });
    const previewSpy = vi.spyOn(comicGenerationApi, "preview")
      .mockResolvedValueOnce({
        confirmationId: null,
        expiresAt: null,
        items: [],
        skipped: [{ clipId: uuid(701), reason: "KEYFRAME_NOT_CONFIRMED" }],
        totalMicros: null,
        currency: "CNY",
      })
      .mockResolvedValueOnce({
        confirmationId: uuid(799),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        items: [{
          clipId: uuid(701), modelId: "doubao-seedance-2-5", unit: "second", quantity: 5, amountMicros: 500_000,
          referenceVersions: [{ mediaId: uuid(704), kind: "appearance", characterName: "丽丽", version: 2 }],
        }],
        skipped: [],
        totalMicros: 500_000,
        currency: "CNY",
      });

    const clipNoFrame: ComicDramaClip = {
      id: uuid(701),
      revision: 1,
      selectionRevision: 1,
      ordinal: 1,
      draft: {
        schemaVersion: 1,
        durationMs: 5000,
        scene: "暴雨便利店",
        shots: [{ id: uuid(702), framingKey: "medium", movementKey: "fixed", description: "推进", durationShare: 100 }],
        lines: [],
      },
      progress: {
        keyframeState: "none", keyframeMediaId: null, keyframeApproved: false, keyframeCandidateAvailable: false,
        keyframeStale: false, videoState: "none", videoTakeCount: 0, adoptedVideoTakeId: null,
        adoptedVideoVersion: null, adoptedVideoMediaId: null, adoptedStale: false, castSnapshotStale: false,
      },
    };
    const clipReadyCandidate: ComicDramaClip = {
      ...clipNoFrame,
      id: uuid(703),
      ordinal: 2,
      draft: { ...clipNoFrame.draft, scene: "门铃响起" },
      progress: {
        ...clipNoFrame.progress!,
        keyframeState: "ready",
        keyframeCandidateAvailable: true,
      },
    };
    const detail = {
      series: {
        id: uuid(11), dramaId: uuid(1), parentId: null, title: "第一集", logline: "", seriesGroup: "雨夜便利店",
        episodeNo: 1, styleKey: "thick_painting", aspectRatio: "9:16" as const, videoModel: "doubao-seedance-2-5",
        revision: 1, archivedAt: null,
      },
      clips: [clipNoFrame, clipReadyCandidate],
      script: null,
      cast: [],
    };
    const selectMock = vi.fn();
    const host = await mount(createElement(ComicImageGeneration, {
      detail,
      selected: clipNoFrame.id,
      select: selectMock,
      getSaved: async () => detail,
      disabled: false,
      initialMode: "from_keyframe",
      choose: vi.fn(),
      editClip: vi.fn(),
    }), "zh");

    expect(host.textContent).toContain("未生成首帧");
    expect(host.textContent).toContain("待确认首帧");
    expect(host.textContent).toContain("当前分镜尚未生成并确认首帧，暂无法按首帧预估费用或提交生成。");

    const previewBtn = Array.from(host.querySelectorAll("button")).find(btn => btn.textContent === "预览视频费用");
    await act(async () => {
      previewBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const dialog = host.querySelector("dialog");
    expect(dialog?.textContent).toContain("请先确认当前分镜的首帧");
    expect(dialog?.textContent).toContain("所选分镜均尚未确认首帧，暂无法预估费用或提交生成");
    const approveFrameBtn = Array.from(dialog?.querySelectorAll("button") ?? []).find(btn => btn.textContent === "去确认首帧");
    const switchRefBtn = Array.from(dialog?.querySelectorAll("button") ?? []).find(btn => btn.textContent === "改用直接参考生成");
    expect(approveFrameBtn).toBeTruthy();
    expect(switchRefBtn).toBeTruthy();

    await act(async () => {
      switchRefBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(previewSpy).toHaveBeenCalledTimes(2);
    expect(previewSpy.mock.calls[1]?.[1]).toMatchObject({ mode: "references" });
    expect(host.querySelector("dialog")?.textContent).toContain("doubao-seedance-2-5");
    expect(host.querySelector("dialog")?.textContent).toContain("丽丽 角色定妆照 V2");
  });

  it("refreshes non-selected video badges and episode counts as each video finishes", async () => {
    vi.useFakeTimers();
    try {
      const seriesId = uuid(11);
      const makeDetail = (completed: number): ComicDramaDetail => ({
        series: {
          id: seriesId, dramaId: uuid(1), parentId: null, title: "第一集", logline: "", seriesGroup: "雨夜便利店",
          episodeNo: 1, styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "doubao-seedance-2-0",
          revision: 1, archivedAt: null,
        },
        clips: [1, 2, 3].map(ordinal => ({
          id: uuid(500 + ordinal), ordinal, revision: 1, selectionRevision: 1,
          draft: { schemaVersion: 1, durationMs: 5000, scene: "", shots: [], lines: [] },
          progress: {
            keyframeState: "none", keyframeMediaId: null, keyframeApproved: false, keyframeStale: false,
            videoState: ordinal <= completed ? "ready" : "running", videoTakeCount: 1, adoptedVideoTakeId: null,
            adoptedVideoVersion: null, adoptedVideoMediaId: null, adoptedStale: false, castSnapshotStale: false,
          },
        })),
        script: null,
        cast: [],
        summary: {
          seriesId, title: "第一集", archived: false, clipCount: 3, completedCount: completed, generatingCount: 3 - completed,
          totalDurationMs: 15_000, estimatedMicros: null, estimatedUnverifiedCount: 0, spentMicros: 0, spentUnverifiedCount: 0, currency: "CNY",
          costs: {
            settled: [], settledTakeCount: 0, quotedUnbilled: [], unbilledReadyCount: 0, pendingReconcileCount: 0,
            remainingEstimate: { currency: "CNY", amountMicros: null, unverifiedCount: 0 },
          },
        },
      });
      const initial = makeDetail(1);
      const get = vi.spyOn(comicDramaApi, "get").mockResolvedValue(initial);
      vi.spyOn(comicDramaApi, "open").mockResolvedValue(initial);
      vi.spyOn(comicDramaApi, "currentSummary").mockResolvedValue({ seriesId, summary: initial.summary! });
      vi.spyOn(comicDramaApi, "currentDrama").mockResolvedValue({ seriesId, dramaId: null, drama: null, episodeCount: 1, castCount: 0 });
      vi.spyOn(comicDirectorApi, "state").mockResolvedValue({ conversationId: null, proposals: [] });
      vi.spyOn(api, "getManagedBalance").mockResolvedValue({ balance: 0, totalUsed: 0, totalRecharged: 0, usedRatio: 0 });
      vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async domain => [...comicSystemDictionary[domain]]);
      vi.spyOn(comicGenerationApi, "creditPauses").mockResolvedValue([]);
      vi.spyOn(comicGenerationApi, "keyframes").mockResolvedValue({ takes: [], approvedTakeId: null, approvedMediaId: null, selectionRevision: 1 });
      const videos = vi.spyOn(comicGenerationApi, "videos").mockResolvedValue([]);
      const host = await mount(createElement(ComicDramaWorkspace, {
        user: { id: uuid(777), name: "User", username: null, phone: null, apiKeys: [], activeKeyIndex: 0 },
        pathname: "/comic-drama/series/" + seriesId, active: true, models: [],
        navigate: vi.fn(), replacePath: vi.fn(), onOpenAssistant: vi.fn(), onOpenDigitalEmployee: vi.fn(), onLogout: vi.fn(),
      }));
      const stage = Array.from(host.querySelectorAll(".comic-steps button")).find(button => button.textContent?.includes("生成"));
      expect(stage).toBeTruthy();
      await act(async () => { (stage as HTMLButtonElement).click(); });
      const mode = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "直接参考生成");
      expect(mode).toBeTruthy();
      await act(async () => { mode!.click(); });

      const badges = () => Array.from(host.querySelectorAll(".comic-generation-targets .comic-pill"), badge => badge.textContent);
      const batch = () => host.querySelector(".comic-batch-banner")?.textContent;
      const episode = () => host.querySelector(".comic-episode-stats")?.textContent;
      expect(badges()).toEqual(["待采用", "生成中", "生成中"]);
      expect(videos).toHaveBeenCalledWith(seriesId, initial.clips[0]!.id, expect.any(AbortSignal));

      get.mockResolvedValue(makeDetail(2));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(badges()).toEqual(["待采用", "待采用", "生成中"]);
      expect(batch()).toContain("生成中 1");
      expect(episode()).toContain("已完成 2/3");

      get.mockResolvedValue(makeDetail(3));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(badges()).toEqual(["待采用", "待采用", "待采用"]);
      expect(batch()).not.toContain("生成中");
      expect(episode()).toContain("已完成 3/3");
      const requests = get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(get).toHaveBeenCalledTimes(requests);
      expect(videos).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops idle polling via shouldPoll, backs off on 429 Retry-After, and pauses when hidden", async () => {
    vi.useFakeTimers();
    try {
      let currentData: Array<{ state: "running" | "ready" }> = [{ state: "running" }];
      const load = vi.fn<() => Promise<Array<{ state: "running" | "ready" }>>>(async () => currentData);
      function Probe() {
        const res = useGenerationHistory(load, 5_000, 0, {
          shouldPoll: rows => rows.some(r => r.state === "running"),
        });
        return createElement("span", null, String(res.current?.length ?? 0));
      }
      await mount(createElement(Probe), "zh");
      expect(load).toHaveBeenCalledTimes(1);

      currentData = [{ state: "ready" }];
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(load).toHaveBeenCalledTimes(2);

      // Should NOT poll again once settled
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(load).toHaveBeenCalledTimes(2);

      // Verify 429 Retry-After backoff
      act(() => root?.unmount());
      document.body.replaceChildren();
      const load429 = vi.fn<() => Promise<Array<{ state: "running" | "ready" }>>>()
        .mockRejectedValueOnce(new ApiClientError("rate limited", 429, undefined, {}, 12_000))
        .mockResolvedValueOnce([{ state: "ready" }]);
      function Probe429() {
        useGenerationHistory(load429, 5_000, 0, {
          shouldPoll: rows => rows.some(r => r.state === "running"),
        });
        return null;
      }
      await mount(createElement(Probe429), "zh");
      expect(load429).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(load429).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
      expect(load429).toHaveBeenCalledTimes(2);

      // Verify hidden tab pauses polling until visible
      act(() => root?.unmount());
      document.body.replaceChildren();
      let visibility: DocumentVisibilityState = "hidden";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      const loadVis = vi.fn(async () => [{ state: "running" as const }]);
      function ProbeVis() {
        useGenerationHistory(loadVis, 5_000, 0, { shouldPoll: () => true });
        return null;
      }
      await mount(createElement(ProbeVis), "zh");
      expect(loadVis).toHaveBeenCalledTimes(0);
      visibility = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
      expect(loadVis).toHaveBeenCalledTimes(1);
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    } finally {
      vi.useRealTimers();
    }
  });
});
