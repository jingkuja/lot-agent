import type { PptSlide } from "../renderer.js";
import { textHeight } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, contrastInk, drawFooter, drawHeading, inkColors, mix, pageBackground, palette, settle } from "./ctx.js";

/** Ordered phases: a numbered line with text below every node, or chevron steps on repeated use. */
export function buildTimeline(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { f } = ctx;
  pageBackground(slide, ctx);
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const frame = drawHeading(slide, s.title, ctx);
  const items = s.items ?? [];
  const n = items.length;
  const step = frame.w / Math.max(n, 1);
  const inner = step - 0.25;
  const labelSize = n > 4 ? 16 : 18, descSize = n > 4 ? 13 : 14;
  const labelH = Math.max(...items.map(it => textHeight(it.label, labelSize, inner)));
  const descH = Math.max(0, ...items.map(it => it.desc ? textHeight(it.desc, descSize, inner, 1.1) : 0));

  if (n <= 5 && (ctx.occurrence ?? 0) % 2 === 1) {
    const chevH = Math.max(0.8, ...items.map(it => textHeight(it.label, labelSize, step - 0.75) + 0.22));
    const total = chevH + (descH ? 0.3 + descH : 0);
    const y = settle(frame, total);
    items.forEach((it, i) => {
      const x = frame.x + i * step;
      const fill = mix(p.accent, p.page, Math.min(0.55, i * 0.14));
      slide.addShape(i === 0 ? "homePlate" : "chevron", { x, y, w: step + 0.12, h: chevH, fill: { color: fill }, line: { color: p.page, width: 2 } });
      const textX = x + (i === 0 ? 0.25 : 0.45);
      slide.addText(it.label, {
        x: textX, y, w: step - 0.75, h: chevH, fontFace: f.major, fontSize: labelSize, bold: true, color: contrastInk(fill), valign: "middle",
      });
      if (it.desc) slide.addText(it.desc, {
        x: x + 0.1, y: y + chevH + 0.3, w: inner, h: descH, fontFace: f.minor, fontSize: descSize, color: ink.body, valign: "top", lineSpacingMultiple: 1.1,
      });
    });
    drawFooter(slide, ctx);
    return;
  }

  const node = 0.42;
  const total = node + 0.3 + labelH + (descH ? 0.1 + descH : 0);
  const y = settle(frame, total);
  const lineY = y + node / 2;
  slide.addShape("line", { x: frame.x + node / 2, y: lineY, w: step * (n - 1), h: 0, line: { color: ink.onBg ? ink.body : p.line, width: 1.5 } });
  items.forEach((it, i) => {
    const x = frame.x + i * step;
    slide.addShape("ellipse", { x, y, w: node, h: node, fill: { color: p.accent }, line: { color: p.page, width: 2 } });
    slide.addText(String(i + 1), { x, y, w: node, h: node, fontFace: f.major, fontSize: 13, bold: true, color: p.onAccent, align: "center", valign: "middle" });
    slide.addText(it.label, { x, y: y + node + 0.3, w: inner, h: labelH, fontFace: f.major, fontSize: labelSize, bold: true, color: ink.title, valign: "top" });
    if (it.desc) {
      slide.addText(it.desc, {
        x, y: y + node + 0.4 + labelH, w: inner, h: descH, fontFace: f.minor, fontSize: descSize, color: ink.body, valign: "top", lineSpacingMultiple: 1.1,
      });
    }
  });
  drawFooter(slide, ctx);
}
