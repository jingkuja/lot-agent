import type { PptSlide } from "../renderer.js";
import { linesFor, textHeight } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, applyBackground, contrastInk, inkColors, mix, palette, styleOf } from "./ctx.js";

/** Section divider: an ordinal plus the section title, in a panel or a large numeral depending on the theme. */
export function buildSection(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { f, W, H } = ctx;
  const p = palette(ctx);
  const number = String((ctx.occurrence ?? 0) + 1).padStart(2, "0");
  const hasBg = applyBackground(slide, ctx);
  const cover = styleOf(ctx).cover;
  const panel = !hasBg && (cover === "split" || cover === "band");
  if (!hasBg) slide.background = { color: p.page };
  const ink = inkColors(ctx);
  let x = 1.0;
  if (panel) {
    const panelW = 4.0;
    const fill = cover === "band" ? p.accent : mix(ctx.c.dk1, "000000", 0.05);
    slide.addShape("rect", { x: 0, y: 0, w: panelW, h: H, fill: { color: fill }, line: { type: "none" } });
    slide.addText(number, {
      x: 0.8, y: H / 2 - 0.9, w: panelW - 1.4, h: 1.6, fontFace: f.major, fontSize: 88, bold: true, color: contrastInk(fill), valign: "middle",
    });
    if (cover === "split") slide.addShape("rect", { x: panelW, y: 0, w: 0.1, h: H, fill: { color: p.accent }, line: { type: "none" } });
    x = panelW + 0.9;
  } else {
    const numeralColor = hasBg ? ink.title : cover === "editorial" ? mix(p.page, p.title, 0.18) : p.accent;
    slide.addText(number, { x: 0.9, y: H / 2 - 1.0, w: 2.6, h: 1.8, fontFace: f.major, fontSize: 104, bold: true, color: numeralColor, valign: "middle" });
    slide.addShape("line", { x: 3.6, y: H / 2 - 0.9, w: 0, h: 1.8, line: { color: hasBg ? ink.body : p.line, width: 1 } });
    x = 4.1;
  }
  const w = W - x - 0.9;
  const size = [36, 32, 28].find(n => linesFor(s.title, n, w) <= 2) ?? 28;
  const titleH = textHeight(s.title, size, w, 1.05);
  const subH = s.subtitle ? textHeight(s.subtitle, 16, w, 1.2) : 0;
  const top = H / 2 - (titleH + (s.subtitle ? 0.25 + subH : 0)) / 2;
  slide.addText(s.title, {
    x, y: top, w, h: titleH, fontFace: f.major, fontSize: size, bold: true, color: ink.title, valign: "top", lineSpacingMultiple: 1.05,
  });
  if (s.subtitle) {
    slide.addText(s.subtitle, {
      x, y: top + titleH + 0.25, w, h: subH, fontFace: f.minor, fontSize: 16, color: ink.body, valign: "top", lineSpacingMultiple: 1.2,
    });
  }
}
