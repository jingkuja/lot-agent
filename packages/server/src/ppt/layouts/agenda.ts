import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, drawFooter, drawHeading, inkColors, pageBackground, palette, settle } from "./ctx.js";

/** Numbered rows with hairlines; more than five entries flow into two columns. */
export function buildAgenda(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { f } = ctx;
  pageBackground(slide, ctx);
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const frame = drawHeading(slide, s.title, ctx);
  const labels = (s.items?.map(it => it.label) ?? ctx.agendaItems ?? []).slice(0, 10);
  const columns = labels.length > 5 ? 2 : 1;
  const rows = Math.ceil(labels.length / columns);
  const gap = 0.6;
  const colW = (frame.w - gap * (columns - 1)) / columns;
  const rowH = Math.max(0.6, Math.min(0.95, (frame.bottom - frame.top) / Math.max(rows, 1)));
  const y0 = settle(frame, rowH * rows);
  labels.forEach((label, i) => {
    const col = Math.floor(i / rows), row = i % rows;
    const x = frame.x + col * (colW + gap), y = y0 + row * rowH;
    slide.addText(String(i + 1).padStart(2, "0"), {
      x, y, w: 0.9, h: rowH, fontFace: f.major, fontSize: 24, bold: true, color: ink.onBg ? ink.title : p.accent, valign: "middle",
    });
    slide.addText(label, { x: x + 1.05, y, w: colW - 1.05, h: rowH, fontFace: f.minor, fontSize: 20, color: ink.title, valign: "middle" });
    if (row < rows - 1) slide.addShape("line", { x, y: y + rowH, w: colW, h: 0, line: { color: ink.onBg ? ink.body : p.line, width: 0.75 } });
  });
  drawFooter(slide, ctx);
}
