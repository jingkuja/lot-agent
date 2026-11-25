// @vitest-environment happy-dom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comicSystemDictionary,
  type ComicDirectorApplyInput, type ComicDirectorProposal, type ComicDramaClipDraft, type ComicDramaDetail,
} from "@lot-agent/core/comic-drama";
import { api } from "../../api/client.js";
import { LanguageProvider } from "../../i18n/index.js";
import { LOCALE_STORAGE_KEY } from "../../i18n/locale.js";
import { EnhanceProposalCard } from "./ComicEnhanceProposal.js";
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

function makeDetail(): ComicDramaDetail {
  return {
    series: {
      id: uuid(1), dramaId: uuid(99), parentId: null, title: "雨夜便利店", logline: "重逢", seriesGroup: null, episodeNo: 1,
      styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "doubao-seedance-2-5", revision: 3, archivedAt: null,
    },
    script: { version: 1, content: "第一段\n\n第二段" },
    cast: [{
      archived: false, hasUpdates: false,
      snapshot: {
        schemaVersion: 1, characterId: uuid(10), name: "林夏", aliases: ["小夏"], age: "22", personality: "冷静",
        appearance: "短发", roleKey: "lead", outfitId: uuid(11), outfitName: "雨衣", assets: [],
      },
    }],
    clips: [],
  };
}

function makeDraft(scene: string, shots: ComicDramaClipDraft["shots"], lines: ComicDramaClipDraft["lines"]): ComicDramaClipDraft {
  return { schemaVersion: 1, durationMs: 6000, scene, shots, lines };
}

function makeProposal(): ComicDirectorProposal {
  return {
    id: uuid(20),
    conversationId: uuid(21),
    baseRevision: 3,
    createdAt: new Date().toISOString(),
    input: {
      requestId: uuid(22), expectedRevision: 3, mode: "paste", language: "zh", text: "",
      action: "enhance", enhance: { scope: "clips", clipIds: [uuid(30), uuid(31)] },
    },
    original: "",
    status: "ready",
    appliedRevision: null,
    proposal: {
      script: "",
      roles: [],
      clipEnhancements: [
        {
          index: 0, clipId: uuid(30), ordinal: 1, baseClipRevision: 1, status: "pending",
          original: makeDraft("原第一镜", [
            { id: uuid(40), framingKey: "wide", movementKey: "fixed", description: "原描述1", durationShare: 100 },
          ], []),
          suggested: makeDraft("建议第一镜", [
            { id: uuid(40), framingKey: "medium", movementKey: "push", description: "建议描述1", durationShare: 100 },
          ], []),
        },
        {
          index: 1, clipId: uuid(31), ordinal: 2, baseClipRevision: 1, status: "pending", notes: "细化双镜头衔接",
          original: makeDraft("原第二镜", [
            { id: uuid(41), framingKey: "medium", movementKey: "fixed", description: "原描述2", durationShare: 100 },
          ], [{ id: uuid(50), speaker: null, text: "原旁白", emotionKey: null, speed: 1 }]),
          suggested: makeDraft("建议第二镜", [
            { id: uuid(41), framingKey: "wide", movementKey: "push", description: "推进镜头", durationShare: 40 },
            { id: uuid(42), framingKey: "close_up", movementKey: "fixed", description: "表情特写", durationShare: 60 },
          ], [{ id: uuid(50), speaker: null, text: "今晚雨真大。", emotionKey: "calm", speed: 1 }]),
        },
      ],
    },
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  if (el instanceof HTMLSelectElement) return;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("EnhanceProposalCard UI", () => {
  it("supports side-by-side review, editing shot parameters, partial adoption of segment 2, and stale alerts", async () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(api, "getProductLinks").mockResolvedValue({
      globle: 0, webUrl: "https://example.com", tokenhubUrl: "https://example.com",
    });
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async domain => [...comicSystemDictionary[domain]]);

    const onApply = vi.fn<(input: Omit<ComicDirectorApplyInput, "expectedRevision">) => void>();
    const onDismiss = vi.fn();
    const onRegenerate = vi.fn();
    const detail = makeDetail();
    const proposal = makeProposal();

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(createElement(LanguageProvider, {
        children: createElement(EnhanceProposalCard, {
          proposal, detail, currentRevision: 3, busy: false, locked: false,
          onApply, onDismiss, onRegenerate,
        }),
      }));
    });

    expect(host.textContent).toContain("分镜增强建议");
    expect(host.textContent).toContain("原第二镜");

    // Edit clip 2's framing, movement, durationShare (70 -> auto-rebalances shot 2 to 30), description, and speaker
    const framingSelect = host.querySelector<HTMLSelectElement>('select[aria-label="分镜 2 镜头 1 景别"]')!;
    const movementSelect = host.querySelector<HTMLSelectElement>('select[aria-label="分镜 2 镜头 1 运镜"]')!;
    const shareInput1 = host.querySelector<HTMLInputElement>('input[aria-label="分镜 2 镜头 1 时长占比"]')!;
    const shareInput2 = host.querySelector<HTMLInputElement>('input[aria-label="分镜 2 镜头 2 时长占比"]')!;
    const descInput = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="分镜 2 镜头 1 描述"]')!;
    const speakerSelect = host.querySelector<HTMLSelectElement>('select[aria-label="分镜 2 台词 1 说话人"]')!;

    act(() => {
      setInputValue(framingSelect, "close_up");
      setInputValue(movementSelect, "orbit");
      setInputValue(shareInput1, "70");
      setInputValue(descInput, "人工微调特写");
      setInputValue(speakerSelect, "林夏");
    });

    expect(shareInput2.value).toBe("30");

    // Adopt ONLY segment 2 (index 1)
    const adoptButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.textContent?.trim() === "采用本段");
    expect(adoptButtons).toHaveLength(2);
    act(() => adoptButtons[1]!.click());

    expect(onApply).toHaveBeenCalledTimes(1);
    const appliedPayload = onApply.mock.calls[0]![0];
    expect(appliedPayload.decision).toBe("enhance");
    expect(appliedPayload.clipItems).toHaveLength(1);
    const clip2Item = appliedPayload.clipItems![0]!;
    expect(clip2Item.index).toBe(1);
    expect(clip2Item.draft?.shots.map(s => s.durationShare)).toEqual([70, 30]);
    expect(clip2Item.draft?.shots[0]?.framingKey).toBe("close_up");
    expect(clip2Item.draft?.shots[0]?.movementKey).toBe("orbit");
    expect(clip2Item.draft?.shots[0]?.description).toBe("人工微调特写");
    expect(clip2Item.draft?.lines[0]?.speaker).toBe("林夏");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Render stale revision state (currentRevision = 4 !== baseRevision = 3)
    await act(async () => {
      root!.render(createElement(LanguageProvider, {
        children: createElement(EnhanceProposalCard, {
          proposal, detail, currentRevision: 4, busy: false, locked: false,
          onApply, onDismiss, onRegenerate,
        }),
      }));
    });
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("原稿已更新，请重新核对");
    const staleAdoptButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.textContent?.trim() === "采用本段");
    expect(staleAdoptButtons.every(b => b.disabled)).toBe(true);
    const regenButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "基于最新草稿重新生成")!;
    expect(regenButton.disabled).toBe(false);
    act(() => regenButton.click());
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("renders English translations cleanly when international locale is active", async () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.spyOn(api, "getProductLinks").mockResolvedValue({
      globle: 1, webUrl: "https://example.com", tokenhubUrl: "https://example.com",
    });
    vi.spyOn(comicLibraryApi, "dictionary").mockImplementation(async domain => [...comicSystemDictionary[domain]]);

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(LanguageProvider, {
        children: createElement(EnhanceProposalCard, {
          proposal: makeProposal(), detail: makeDetail(), currentRevision: 3, busy: false, locked: false,
          onApply: vi.fn(), onDismiss: vi.fn(),
        }),
      }));
    });
    expect(host.textContent).toContain("Storyboard enhancement suggestions");
    expect(host.textContent).toContain("Adopt segment");
    expect(host.textContent).toContain("Dismiss segment");
  });
});
