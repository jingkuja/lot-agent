import { describe, it, expect } from "vitest";
import { EMPTY_SELECTED, fillModelDefaults, groupForKind, resolveLlmSelection } from "./model-defaults.js";
import type { CatalogModel } from "./model-filter.js";

const m = (id: string, type: CatalogModel["type"]): CatalogModel => ({ id, type, provider: "p" });

const catalog = {
  llm: [m("gpt-a", "llm"), m("gpt-b", "llm")],
  image: [m("img-a", "image")],
  video: [] as CatalogModel[],
};

describe("fillModelDefaults", () => {
  it("fills null slots with each group's first model id", () => {
    expect(fillModelDefaults(EMPTY_SELECTED, catalog)).toEqual({
      llm: "gpt-a",
      image: "img-a",
      video: null,
    });
  });

  it("preserves existing picks", () => {
    const prev = { llm: "gpt-b", image: null, video: null };
    expect(fillModelDefaults(prev, catalog)).toEqual({
      llm: "gpt-b",
      image: "img-a",
      video: null,
    });
  });

  it("is a no-op on an empty catalog", () => {
    const empty = { llm: [], image: [], video: [] };
    expect(fillModelDefaults(EMPTY_SELECTED, empty)).toEqual(EMPTY_SELECTED);
  });
});

describe("resolveLlmSelection", () => {
  it("keeps the persisted model when it is still in the catalog", () => {
    expect(resolveLlmSelection("gpt-b", catalog.llm)).toBe("gpt-b");
  });

  it("falls back to the first model when the persisted model is gone (e.g. after switching API key)", () => {
    expect(resolveLlmSelection("old-model", catalog.llm)).toBe("gpt-a");
  });

  it("falls back to the first model for a brand-new conversation (null persisted)", () => {
    expect(resolveLlmSelection(null, catalog.llm)).toBe("gpt-a");
  });

  it("returns null when the catalog is empty", () => {
    expect(resolveLlmSelection("gpt-a", [])).toBeNull();
    expect(resolveLlmSelection(null, [])).toBeNull();
  });
});

describe("groupForKind", () => {
  it("maps image/video kinds to their group and everything else to llm", () => {
    expect(groupForKind("image")).toBe("image");
    expect(groupForKind("video")).toBe("video");
    expect(groupForKind("general")).toBe("llm");
    expect(groupForKind("copywriting")).toBe("llm");
    expect(groupForKind(undefined)).toBe("llm");
  });
});
