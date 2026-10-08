import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, cardColor, drawFooter, applyBackground, inkColors } from "./ctx.js";

export function buildStats(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addText(s.title, { x: W * 0.06, y: H * 0.1, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 32, bold: true, color: ink.title });
  const items = s.items ?? [];
  const n = items.length;
  const gap = W * 0.04;
  const cardW = (W * 0.88 - gap * (n - 1)) / n;
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const x = W * 0.06 + i * (cardW + gap);
    const textX = x + .18, textW = cardW - .36;
    slide.addShape("roundRect", { x, y: H * 0.31, w: cardW, h: H * 0.47, rectRadius: 0.12, fill: { color: cardColor(c) }, line: { color: accent, width: 1.5 } });
    slide.addText(it.value ?? "", { x: textX, y: H * 0.34, w: textW, h: H * 0.16, fontFace: f.major, fontSize: 44, bold: true, color: accent, align: "center" });
    slide.addText(it.label, { x: textX, y: H * 0.52, w: textW, h: H * 0.1, fontFace: f.minor, fontSize: 18, color: c.dk2, align: "center" });
    if (it.desc) slide.addText(it.desc, { x: textX, y: H * 0.64, w: textW, h: H * 0.11, fontFace: f.minor, fontSize: 14, color: c.dk2, align: "center" });
  });
  drawFooter(slide, ctx);
}
