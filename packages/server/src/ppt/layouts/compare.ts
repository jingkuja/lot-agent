import type { PptColumn, PptSlide } from "../renderer.js";
import { textHeight } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, drawCard, drawFooter, drawHeading, inkColors, pageBackground, palette, settle } from "./ctx.js";

/** Matching point counts compare row by row; otherwise two panels, with the right (proposed) side emphasized. */
export function buildCompare(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { f } = ctx;
  const hasBg = pageBackground(slide, ctx);
  const p = palette(ctx);
  const frame = drawHeading(slide, s.title, ctx);
  const left = s.left!, right = s.right!;
  const gap = 0.5;
  const colW = (frame.w - gap) / 2;
  const available = frame.bottom - frame.top;
  const pad = 0.26, inner = colW - pad * 2;
  const headH = Math.max(textHeight(left.title, 17, inner), textHeight(right.title, 17, inner));
  const textGap = 0.12;
  const needed = (c: PptColumn, size: number) => c.bullets.reduce((sum, b) => sum + textHeight(b, size, inner - 0.26, 1.1) + textGap, -textGap);
  const availableText = available - headH - pad * 2 - 0.32;
  const panelSize = [18, 16, 14, 12].find(size => Math.max(needed(left, size), needed(right, size)) <= availableText);
  const paired = !hasBg && (ctx.occurrence ?? 0) % 2 === 0 && left.bullets.length === right.bullets.length && left.bullets.length >= 2;

  if (paired || panelSize === undefined) {
    const ink = inkColors(ctx);
    const textW = colW - 0.5;
    const count = Math.max(left.bullets.length, right.bullets.length);
    const measure = (size: number) => {
      const headingSize = Math.min(17, Math.max(12, size + 1));
      const headingH = Math.max(0.5, textHeight(left.title, headingSize, textW), textHeight(right.title, headingSize, textW));
      const rowPad = size >= 14 ? (count > 3 ? 0.08 : 0.16) : 0.03;
      const rows = Array.from({ length: count }, (_, i) => Math.max(
        textHeight(left.bullets[i] ?? "", size, textW, 1.1), textHeight(right.bullets[i] ?? "", size, textW, 1.1),
      ) + rowPad * 2);
      return { rows, headingH, headingSize, rowPad, total: headingH + rows.reduce((sum, h) => sum + h, 0) };
    };
    const size = [18, 16, 14, 12, 11, 10, 9, 8].find(size => measure(size).total <= available) ?? 7;
    const { rows, headingH, headingSize, rowPad, total } = measure(size);
    let y = settle(frame, total);
    slide.addShape("roundRect", { x: frame.x, y, w: colW, h: headingH, rectRadius: 0.05, fill: { color: p.soft }, line: { type: "none" } });
    slide.addShape("roundRect", { x: frame.x + colW + gap, y, w: colW, h: headingH, rectRadius: 0.05, fill: { color: p.accent }, line: { type: "none" } });
    const heading = { y, w: textW, h: headingH, fontFace: f.major, fontSize: headingSize, bold: true, valign: "middle" };
    slide.addText(left.title, { ...heading, x: frame.x + 0.25, color: p.title });
    slide.addText(right.title, { ...heading, x: frame.x + colW + gap + 0.25, color: p.onAccent });
    y += headingH;
    rows.forEach((h, i) => {
      const common = { y: y + rowPad, w: textW, h: h - rowPad * 2, fontFace: f.minor, fontSize: size, valign: "top", lineSpacingMultiple: 1.1 };
      if (left.bullets[i]) slide.addText(left.bullets[i], { ...common, x: frame.x + 0.25, color: ink.body });
      if (right.bullets[i]) slide.addText(right.bullets[i], { ...common, x: frame.x + colW + gap + 0.25, color: ink.title });
      if (i < rows.length - 1) slide.addShape("line", { x: frame.x, y: y + h, w: frame.w, h: 0, line: { color: p.line, width: 0.75 } });
      y += h;
    });
    drawFooter(slide, ctx);
    return;
  }

  const size = panelSize;
  const cardH = Math.max(needed(left, size), needed(right, size)) + headH + pad * 2 + 0.32;
  const y = settle(frame, cardH);
  ([[left, false], [right, true]] as const).forEach(([column, emphasis], i) => {
    const x = frame.x + i * (colW + gap);
    const ink = drawCard(slide, ctx, { x, y, w: colW, h: cardH });
    slide.addText(column.title, {
      x: x + pad, y: y + pad, w: inner, h: headH, fontFace: f.major, fontSize: 17, bold: true, color: ink.title, valign: "middle",
    });
    slide.addShape("line", {
      x: x + pad, y: y + pad + headH + 0.12, w: inner, h: 0, line: { color: emphasis ? p.accent : p.line, width: emphasis ? 1.5 : 0.75 },
    });
    let ty = y + pad + headH + 0.32;
    column.bullets.forEach(b => {
      const h = textHeight(b, size, inner - 0.26, 1.1);
      slide.addShape("ellipse", {
        x: x + pad, y: ty + size * 0.66 / 72 - 0.04, w: 0.08, h: 0.08, fill: { color: emphasis ? p.accent : p.muted }, line: { type: "none" },
      });
      slide.addText(b, {
        x: x + pad + 0.26, y: ty, w: inner - 0.26, h, fontFace: f.minor, fontSize: size, color: ink.body, valign: "top", lineSpacingMultiple: 1.1,
      });
      ty += h + textGap;
    });
  });
  drawFooter(slide, ctx);
}
