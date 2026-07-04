import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter, applyBackground, inkColors } from "./ctx.js";

export function buildStats(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addText(s.title, { x: W * 0.06, y: H * 0.1, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: ink.title });
  const items = s.items ?? [];
  const n = items.length;
  const gap = W * 0.04;
  const cardW = (W * 0.88 - gap * (n - 1)) / n;
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const x = W * 0.06 + i * (cardW + gap);
    slide.addShape("roundRect", { x, y: H * 0.32, w: cardW, h: H * 0.42, rectRadius: 0.12, fill: { color: c.lt1 }, line: { color: accent, width: 1.5 } });
    slide.addText(it.value ?? "", { x, y: H * 0.36, w: cardW, h: H * 0.2, fontFace: f.major, fontSize: 44, bold: true, color: accent, align: "center" });
    slide.addText(it.label, { x, y: H * 0.58, w: cardW, h: H * 0.12, fontFace: f.minor, fontSize: 15, color: c.dk2, align: "center" });
    if (it.desc) slide.addText(it.desc, { x, y: H * 0.66, w: cardW, h: H * 0.08, fontFace: f.minor, fontSize: 11, color: c.dk2, align: "center" });
  });
  drawFooter(slide, ctx);
}
