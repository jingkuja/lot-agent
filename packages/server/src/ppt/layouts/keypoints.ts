import type { PptSlide } from "../renderer.js";
import { textHeight } from "../text-fit.js";
import { drawIcon } from "./icons.js";
import { type BuildCtx, type PptxSlide, drawCard, drawFooter, drawHeading, inkColors, pageBackground, palette, settle } from "./ctx.js";

/** Cards sized to their content; a second occurrence of 2-4 points uses open numbered columns. */
export function buildKeypoints(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { f } = ctx;
  const hasBg = pageBackground(slide, ctx);
  const p = palette(ctx);
  const frame = drawHeading(slide, s.title, ctx);
  const items = s.items ?? [];
  const n = items.length;
  const available = frame.bottom - frame.top;

  if (!hasBg && n <= 4 && (ctx.occurrence ?? 0) % 2 === 1) {
    const ink = inkColors(ctx);
    const gap = 0.5;
    const w = (frame.w - gap * (n - 1)) / n;
    const labelH = Math.max(...items.map(it => textHeight(it.label, 20, w)));
    const descH = Math.max(0, ...items.map(it => it.desc ? textHeight(it.desc, 16, w, 1.15) : 0));
    const total = 0.7 + 0.25 + labelH + (descH ? 0.15 + descH : 0);
    if (total <= available) {
      const y = settle(frame, total);
      items.forEach((it, i) => {
        const x = frame.x + i * (w + gap);
        if (it.icon) drawIcon(slide, it.icon, x, y + 0.1, 0.5, p.accent);
        else slide.addText(String(i + 1).padStart(2, "0"), { x, y, w, h: 0.7, fontFace: f.major, fontSize: 32, bold: true, color: p.accent });
        slide.addShape("line", { x, y: y + 0.82, w: w - 0.1, h: 0, line: { color: p.accent, width: 1.5 } });
        slide.addText(it.label, { x, y: y + 0.95, w, h: labelH, fontFace: f.major, fontSize: 20, bold: true, color: ink.title, valign: "top" });
        if (it.desc) slide.addText(it.desc, {
          x, y: y + 1.1 + labelH, w, h: descH, fontFace: f.minor, fontSize: 16, color: ink.body, valign: "top", lineSpacingMultiple: 1.15,
        });
        if (i < n - 1) slide.addShape("line", { x: x + w + gap / 2, y, w: 0, h: total, line: { color: p.line, width: 0.75 } });
      });
      drawFooter(slide, ctx);
      return;
    }
  }

  const cols = n <= 3 ? Math.max(n, 1) : n === 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const gapX = 0.4, gapY = 0.32;
  const cardW = (frame.w - gapX * (cols - 1)) / cols;
  const pad = rows > 1 ? 0.22 : 0.32;
  const innerW = cardW - pad * 2;
  const iconSize = rows > 1 ? 0.34 : 0.4;
  const iconW = items.some(it => it.icon) ? iconSize + 0.12 : 0;
  const measure = (size: number) => items.map(it => ({
    labelH: Math.max(iconW ? iconSize : 0, textHeight(it.label, size, innerW - iconW)),
    descH: it.desc ? textHeight(it.desc, size - 3, innerW, 1.12) : 0,
  }));
  const rowHeights = (boxes: ReturnType<typeof measure>) => Array.from({ length: rows }, (_, row) => Math.max(
    ...boxes.slice(row * cols, (row + 1) * cols).map(({ labelH, descH }) => 2 * pad + labelH + (descH ? 0.13 + descH : 0)),
  ));
  const blockHeight = (heights: number[]) => heights.reduce((sum, h) => sum + h, 0) + gapY * (rows - 1);
  let labelSize = n > 4 ? 18 : 20;
  let boxes = measure(labelSize);
  let heights = rowHeights(boxes);
  while (blockHeight(heights) > available && labelSize > 10) {
    boxes = measure(--labelSize);
    heights = rowHeights(boxes);
  }
  const extra = Math.max(0, Math.min(0.26, (available - blockHeight(heights)) / rows));
  heights = heights.map(h => h + extra);
  const y0 = settle(frame, blockHeight(heights));
  items.forEach((it, i) => {
    const x = frame.x + (i % cols) * (cardW + gapX);
    const row = Math.floor(i / cols);
    const y = y0 + (row ? heights[0] + gapY : 0);
    const { labelH, descH } = boxes[i];
    const ink = drawCard(slide, ctx, { x, y, w: cardW, h: heights[row] });
    const ty = y + pad + extra / 2;
    if (it.icon) drawIcon(slide, it.icon, x + pad, ty, iconSize, p.accent);
    slide.addText(it.label, {
      x: x + pad + iconW, y: ty, w: innerW - iconW, h: labelH, fontFace: f.major, fontSize: labelSize, bold: true, color: ink.title, valign: "top",
    });
    if (it.desc) {
      slide.addText(it.desc, {
        x: x + pad, y: ty + labelH + 0.13, w: innerW, h: descH,
        fontFace: f.minor, fontSize: labelSize - 3, color: ink.body, valign: "top", lineSpacingMultiple: 1.12,
      });
    }
  });
  drawFooter(slide, ctx);
}
