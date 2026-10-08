import { describe, expect, it } from "vitest";
import { validateDeck, validateSlides, encodePptApproval, parsePptApproval, parsePptArtifact, inspectDeck, type PptDeck } from "./deck.js";

const deck: PptDeck = { title: "季度经营复盘", themePreset: "business", slides: [{ layout: "cover", title: "季度经营复盘" }] };

describe("presentation contract", () => {
  it("round-trips the exact approved content and template settings", () => {
    const approved = { ...deck, templateAssetId: "owned-template", backgrounds: [{ assetId: "owned-bg", role: "cover" as const }] };
    expect(parsePptApproval(encodePptApproval(approved))).toEqual(approved);
    expect(parsePptApproval("确认生成")).toBeNull();
    expect(() => parsePptApproval("[lot-ppt-confirmation:v1]\n{}" )).toThrow();
  });
  it("rejects malformed optional fields and excessive text with a field location", () => {
    expect(validateSlides([{ layout: "content", title: "T", bullets: [" "] }])).toContain("bullets");
    expect(validateSlides([{ layout: "keypoints", title: "T", items: [{ label: "a", desc: {} }, { label: "b" }] }])).toContain("desc");
    expect(validateSlides([{ layout: "content", title: "T", bullets: ["长".repeat(100)] }])).toContain("第 1 页.bullets[1]");
    expect(validateSlides([{ layout: "content", title: "T", bullets: ["A concise sentence in English, with enough room for normal wording."] }])).toBeNull();
  });
  it("requires chart evidence and aligned finite data, without rejecting valid zero values", () => {
    const chart = { type: "bar", categories: ["Q1", "Q2"], series: [{ name: "收入", values: [0, 12] }], unit: "万元", source: "用户上传的季度报表，第 2 页" };
    const slide = { layout: "chart", title: "收入变化", chart };
    expect(validateSlides([slide])).toBeNull();
    expect(validateSlides([{ ...slide, chart: { ...chart, source: "" } }])).toContain("source");
    expect(validateSlides([{ ...slide, chart: { ...chart, series: [{ name: "收入", values: [1] }] } }])).toContain("values");
    expect(validateSlides([{ ...slide, chart: { ...chart, series: [{ name: "收入", values: [NaN, 1] }] } }])).toContain("values");
    expect(validateSlides([{ ...slide, chart: { ...chart, type: "pie", series: [{ name: "收入", values: [-1, 2] }] } }])).toContain("pie");
  });
  it("enforces the agreed page count and surfaces narrative issues without fabricating fixes", () => {
    expect(validateDeck({ ...deck, brief: { targetSlides: 8 } })).toContain("8");
    expect(validateDeck({ ...deck, themePreset: "invented" })).toContain("themePreset");
    const repeated = { ...deck, slides: Array.from({ length: 3 }, () => ({ layout: "content" as const, title: "同一个标题", bullets: ["关键事实"] })) };
    expect(inspectDeck(repeated).some(w => w.code === "repeated-title")).toBe(true);
    expect(inspectDeck(repeated).some(w => w.code === "layout-rhythm")).toBe(true);
  });
  it("does not silently ignore incompatible layout fields or relabel partial previews", () => {
    expect(validateSlides([{ layout: "content", title: "T", bullets: ["A"], items: [{ label: "must not vanish" }] }])).toContain("items");
    expect(validateSlides([{ layout: "quote", quote: { text: "valid text" } }])).toContain("title");
    expect(validateSlides([{ layout: "agenda", title: "T", items: [{ label: "A", desc: "must not vanish" }, { label: "B" }] }])).toContain("desc");
    expect(validateSlides([{ layout: "keypoints", title: "T", items: [{ label: "A", value: "12" }, { label: "B" }] }])).toContain("value");
    const artifact = parsePptArtifact("ppt_artifact: " + JSON.stringify({ version: 1, deck, warnings: [], previewStatus: "ready", previewUrls: ["javascript:alert(1)", "/static/documents/slide2.png"] }));
    expect(artifact?.previewUrls).toEqual([]);
    expect(artifact?.previewStatus).toBe("unavailable");
  });
});
