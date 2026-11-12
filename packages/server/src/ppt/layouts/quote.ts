import type { PptSlide } from "../renderer.js";
import { textHeight } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, MARGIN_X, drawFooter, drawHeading, inkColors, pageBackground, palette, settle } from "./ctx.js";

export function buildQuote(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  pageBackground(slide, ctx);
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const frame = s.title.trim() ? drawHeading(slide, s.title, ctx) : { x: MARGIN_X, w: ctx.W - 2 * MARGIN_X, top: 0.65, bottom: ctx.H - 1 };
  const { text, author } = s.quote!;
  const x = frame.x + 0.45;
  const w = frame.w - 0.9;
  const authorH = author ? textHeight(author, 15, w) : 0;
  const extra = 0.72 + (author ? 0.3 + authorH : 0);
  const available = frame.bottom - frame.top - extra;
  let size = 28;
  while (size > 14 && textHeight(text, size, w, 1.1) > available) size -= 2;
  const h = textHeight(text, size, w, 1.1);
  const y = settle(frame, extra + h);
  slide.addText("“", { x, y, w: 0.9, h: 0.72, fontFace: ctx.f.major, fontSize: 48, bold: true, color: ink.onBg ? ink.title : p.accent });
  slide.addText(text, {
    x, y: y + 0.72, w, h, fontFace: ctx.f.major, fontSize: size, bold: true, color: ink.title, valign: "top", lineSpacingMultiple: 1.1,
  });
  if (author) slide.addText(`— ${author}`, { x, y: y + 1.02 + h, w, h: authorH, fontFace: ctx.f.minor, fontSize: 15, color: ink.body });
  drawFooter(slide, ctx);
}
