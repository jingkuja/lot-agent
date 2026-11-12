import { textUnits } from "@lot-agent/core/presentation";
import type { PptSlide } from "../renderer.js";
import { fitRows, textHeight } from "../text-fit.js";
import {
  type BuildCtx, type Frame, type PptxSlide, MARGIN_X, drawFooter, drawHeading, inkColors, pageBackground, palette, settle,
} from "./ctx.js";

const LABELED = /^(.{1,14}?)[：:]\s*(.+)$/su;

/** "Label: explanation" points, when most points follow that shape. */
function splitLabels(bullets: string[]): { label: string; text: string }[] | null {
  const rows = bullets.map(b => {
    const m = LABELED.exec(b);
    return m && textUnits(m[1]) <= 12 ? { label: m[1].trim(), text: m[2].trim() } : { label: "", text: b };
  });
  return bullets.length >= 2 && rows.filter(r => r.label).length >= Math.ceil(bullets.length * 2 / 3) ? rows : null;
}

function drawList(slide: PptxSlide, bullets: string[], ctx: BuildCtx, frame: Frame, numbered: boolean): void {
  const { f } = ctx;
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const indent = numbered ? 0.6 : 0.36;
  const textW = frame.w - indent;
  const sizes = bullets.length <= 3 ? [22, 20, 18, 16, 14, 12] : [20, 18, 16, 14, 12, 11, 10];
  const available = frame.bottom - frame.top;
  const fit = fitRows(size => bullets.map(b => textHeight(b, size, textW, 1.1)), available, sizes, 0.13, 0.45);
  if (fit.total > available && bullets.length > 4) {
    const middle = Math.ceil(bullets.length / 2);
    const w = (frame.w - 0.5) / 2;
    drawList(slide, bullets.slice(0, middle), ctx, { ...frame, w }, false);
    drawList(slide, bullets.slice(middle), ctx, { ...frame, x: frame.x + w + 0.5, w }, false);
    return;
  }
  let y = settle(frame, fit.total);
  bullets.forEach((b, i) => {
    const lineH = fit.size * 1.32 / 72;
    if (numbered) {
      slide.addText(String(i + 1).padStart(2, "0"), {
        x: frame.x, y, w: 0.55, h: lineH + 0.06, fontFace: f.major, fontSize: fit.size, bold: true, color: ink.onBg ? ink.title : p.accent,
      });
    } else {
      slide.addShape("rect", {
        x: frame.x + 0.02, y: y + lineH / 2 - 0.02, w: 0.11, h: 0.11, fill: { color: ink.onBg ? ink.title : p.accent }, line: { type: "none" },
      });
    }
    slide.addText(b, {
      x: frame.x + indent, y, w: textW, h: fit.rows[i], fontFace: f.minor, fontSize: fit.size, color: ink.body, valign: "top", lineSpacingMultiple: 1.1,
    });
    y += fit.rows[i] + fit.gap;
  });
}

function drawLabeled(slide: PptxSlide, rows: { label: string; text: string }[], ctx: BuildCtx, frame: Frame): boolean {
  const { f } = ctx;
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const labelW = Math.min(3.4, Math.max(1.8, Math.max(...rows.map(r => textUnits(r.label))) * 0.3 + 0.4));
  const textX = frame.x + labelW + 0.3, textW = frame.w - labelW - 0.3;
  const pad = rows.length > 5 ? 0.08 : 0.16;
  const heights = (size: number) => rows.map(r => Math.max(textHeight(r.label, size, labelW), textHeight(r.text, size, textW, 1.1)) + pad * 2);
  const fit = fitRows(heights, frame.bottom - frame.top, [20, 18, 16, 14, 12, 11], 0, 0.12);
  if (fit.total > frame.bottom - frame.top) return false;
  let y = settle(frame, fit.total);
  rows.forEach((row, i) => {
    const h = fit.rows[i];
    if (row.label) {
      slide.addText(row.label, {
        x: frame.x, y: y + pad, w: labelW, h: h - pad * 2, fontFace: f.major, fontSize: fit.size, bold: true, color: ink.title, valign: "top",
      });
    }
    slide.addText(row.text, {
      x: row.label ? textX : frame.x, y: y + pad, w: row.label ? textW : frame.w, h: h - pad * 2,
      fontFace: f.minor, fontSize: fit.size, color: ink.body, valign: "top", lineSpacingMultiple: 1.1,
    });
    if (i < rows.length - 1) slide.addShape("line", {
      x: frame.x, y: y + h + fit.gap / 2, w: frame.w, h: 0, line: { color: ink.onBg ? ink.body : p.line, width: 0.75 },
    });
    y += h + fit.gap;
  });
  return true;
}

/** Two or three short points read better as statement columns than as a sparse list. */
function drawColumns(slide: PptxSlide, bullets: string[], ctx: BuildCtx, frame: Frame): void {
  const { f } = ctx;
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const gap = 0.6;
  const w = (frame.w - gap * (bullets.length - 1)) / bullets.length;
  const textH = Math.max(...bullets.map(b => textHeight(b, 22, w, 1.15)));
  const total = 0.75 + 0.3 + textH;
  const y = settle(frame, total);
  bullets.forEach((b, i) => {
    const x = frame.x + i * (w + gap);
    slide.addText(String(i + 1).padStart(2, "0"), { x, y, w, h: 0.75, fontFace: f.major, fontSize: 36, bold: true, color: ink.onBg ? ink.title : p.accent });
    slide.addShape("line", { x, y: y + 0.88, w: w * 0.9, h: 0, line: { color: ink.onBg ? ink.body : p.line, width: 1 } });
    slide.addText(b, { x, y: y + 1.05, w, h: textH, fontFace: f.minor, fontSize: 22, color: ink.title, valign: "top", lineSpacingMultiple: 1.15 });
  });
}

export function buildContent(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { W, H } = ctx;
  const hasBg = pageBackground(slide, ctx);
  const p = palette(ctx);
  const bullets = s.bullets ?? [];
  const labeled = splitLabels(bullets);
  const short = bullets.length >= 2 && bullets.length <= 3 && bullets.every(b => textUnits(b) <= 34);
  // Repeated plain lists alternate with a side-title composition to keep the deck's rhythm.
  if (!labeled && !short && (ctx.occurrence ?? 0) % 2 === 1 && bullets.length <= 6 && W >= 12) {
    const sideW = 4.1;
    if (!hasBg) slide.addShape("rect", { x: 0, y: 0, w: sideW + MARGIN_X, h: H, fill: { color: p.soft }, line: { type: "none" } });
    drawHeading(slide, s.title, ctx, { x: MARGIN_X, w: sideW - 0.4 });
    const listX = sideW + MARGIN_X + 0.7;
    drawList(slide, bullets, ctx, { x: listX, w: W - listX - MARGIN_X, top: 0.9, bottom: H - 1.0 }, true);
  } else {
    const frame = drawHeading(slide, s.title, ctx);
    if (short && !labeled) drawColumns(slide, bullets, ctx, frame);
    else if (!labeled || !drawLabeled(slide, labeled, ctx, frame)) drawList(slide, bullets, ctx, frame, false);
  }
  drawFooter(slide, ctx);
}
