import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildKeypoints(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.lt2 };
  slide.addText(s.title, { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: c.dk1 });
  const items = s.items ?? [];
  const cols = items.length <= 3 ? items.length : 2;
  const rows = Math.ceil(items.length / cols);
  const gapX = W * 0.04, gapY = H * 0.04;
  const cardW = (W * 0.88 - gapX * (cols - 1)) / cols;
  const cardH = (H * 0.58 - gapY * (rows - 1)) / rows;
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const cx = i % cols, cy = Math.floor(i / cols);
    const x = W * 0.06 + cx * (cardW + gapX);
    const y = H * 0.26 + cy * (cardH + gapY);
    slide.addShape("roundRect", { x, y, w: cardW, h: cardH, rectRadius: 0.08, fill: { color: c.lt1 }, line: { color: c.lt2, width: 1 } });
    slide.addShape("rect", { x, y, w: 0.08, h: cardH, fill: { color: accent } });
    slide.addText(it.label, { x: x + 0.25, y: y + cardH * 0.12, w: cardW - 0.4, h: cardH * 0.35, fontFace: f.major, fontSize: 18, bold: true, color: c.dk1 });
    if (it.desc) slide.addText(it.desc, { x: x + 0.25, y: y + cardH * 0.5, w: cardW - 0.4, h: cardH * 0.42, fontFace: f.minor, fontSize: 13, color: c.dk2, valign: "top", lineSpacingMultiple: 1.3 });
  });
  drawFooter(slide, ctx);
}
