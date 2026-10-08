import type { PptSlide } from "../renderer.js";
import { drawIcon } from "./icons.js";
import { type BuildCtx, type PptxSlide, accentAt, cardColor, drawFooter, applyBackground, inkColors } from "./ctx.js";

export function buildKeypoints(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addText(s.title, { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 32, bold: true, color: ink.title });
  const items = s.items ?? [];
  const cols = items.length <= 3 ? Math.max(items.length, 1) : items.length === 4 ? 2 : 3;
  const rows = Math.ceil(items.length / cols);
  const gapX = W * 0.04, gapY = H * 0.04;
  const cardW = (W * 0.88 - gapX * (cols - 1)) / cols;
  const cardH = (H * 0.58 - gapY * (rows - 1)) / rows;
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const cx = i % cols, cy = Math.floor(i / cols);
    const x = W * 0.06 + cx * (cardW + gapX);
    const y = H * 0.26 + cy * (cardH + gapY);
    slide.addShape("roundRect", { x, y, w: cardW, h: cardH, rectRadius: 0.08, fill: { color: cardColor(c) }, line: { color: c.lt2, width: 1 } });
    slide.addShape("rect", { x, y, w: 0.08, h: cardH, fill: { color: accent } });
    const iconSize = Math.min(0.35, cardH * 0.23);
    if (it.icon) drawIcon(slide, it.icon, x + .24, y + cardH * .15, iconSize, accent);
    const labelOffset = it.icon ? iconSize + .4 : .25;
    slide.addText(it.label, { x: x + labelOffset, y: y + cardH * 0.12, w: cardW - labelOffset - .2, h: cardH * 0.35, fontFace: f.major, fontSize: 20, bold: true, color: c.dk1 });
    if (it.desc) slide.addText(it.desc, { x: x + 0.25, y: y + cardH * 0.5, w: cardW - 0.4, h: cardH * 0.42, fontFace: f.minor, fontSize: 17, color: c.dk2, valign: "top", lineSpacingMultiple: 1.3 });
  });
  drawFooter(slide, ctx);
}
