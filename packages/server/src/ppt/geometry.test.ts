import { describe, expect, it, vi } from "vitest";
import { buildTimeline } from "./layouts/timeline.js";
import { buildKeypoints } from "./layouts/keypoints.js";
import { buildStats } from "./layouts/stats.js";
import { cardColor, contrastInk, type BuildCtx } from "./layouts/ctx.js";
import { THEME_PRESETS } from "./themes.js";

describe("slide geometry and contrast", () => {
  it.each([3, 6])("keeps all %i timeline labels within the page", count => {
    const theme = THEME_PRESETS.business;
    const ctx: BuildCtx = { c: theme.colors, f: theme.fonts, W: 13.333, H: 7.5, theme, index: 0, total: 1, presTitle: "T", layout: "timeline" };
    const addText = vi.fn((_text: unknown, _options: Record<string, number>) => {});
    buildTimeline({ addText, addShape: vi.fn() }, { layout: "timeline", title: "计划", items: Array.from({ length: count }, (_, i) => ({ label: `阶段 ${i + 1}`, desc: "完成交付" })) }, ctx);
    for (const [, box] of addText.mock.calls) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(ctx.W);
      expect(box.y + box.h).toBeLessThanOrEqual(ctx.H);
    }
  });
  it("uses two rows for six keypoints and a dark card surface in the dark theme", () => {
    const theme = THEME_PRESETS["tech-dark"];
    const ctx: BuildCtx = { c: theme.colors, f: theme.fonts, W: 13.333, H: 7.5, theme, index: 0, total: 1, presTitle: "T", layout: "keypoints" };
    const addShape = vi.fn((_shape: string, _options: Record<string, any>) => {});
    buildKeypoints({ addText: vi.fn(), addShape }, { layout: "keypoints", title: "T", items: Array.from({ length: 6 }, () => ({ label: "要点", desc: "清楚的解释" })) }, ctx);
    const cards = addShape.mock.calls.filter(([shape]) => shape === "roundRect").map(([, box]) => box);
    expect(new Set(cards.map(box => box.y)).size).toBe(2);
    expect(cardColor(theme.colors)).not.toBe("FFFFFF");
    expect(contrastInk("FFFFFF")).not.toBe("FFFFFF");
    expect(contrastInk("141A24")).toBe("FFFFFF");
  });
  it("keeps metric labels and explanations in separate padded text regions", () => {
    const theme = THEME_PRESETS.business;
    const ctx: BuildCtx = { c: theme.colors, f: theme.fonts, W: 13.333, H: 7.5, theme, index: 0, total: 1, presTitle: "T", layout: "stats" };
    const addText = vi.fn((_text: string, _options: Record<string, number>) => {});
    buildStats({ addText, addShape: vi.fn() }, { layout: "stats", title: "指标", items: [{ label: "指标标签", value: "1,280 万", desc: "指标解释" }, { label: "另一指标", value: "2", desc: "说明" }] }, ctx);
    const label = addText.mock.calls.find(([text]) => text === "指标标签")![1];
    const desc = addText.mock.calls.find(([text]) => text === "指标解释")![1];
    expect(label.y + label.h).toBeLessThan(desc.y);
    expect(label.x).toBeGreaterThan(ctx.W * .06);
  });
});
