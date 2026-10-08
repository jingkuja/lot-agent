import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, drawFooter, applyBackground, inkColors } from "./ctx.js";

export function buildContent(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const accent = c.accent1;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addShape("rect", { x: 0, y: 0, w: W, h: 0.07, fill: { color: accent } });
  slide.addText(s.title, { x: W * 0.06, y: H * 0.07, w: W * 0.88, h: H * 0.13, fontFace: f.major, fontSize: 32, bold: true, color: ink.title });
  slide.addShape("rect", { x: W * 0.06, y: H * 0.2, w: W * 0.14, h: 0.04, fill: { color: accent } });
  if (s.bullets?.length) {
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: { color: accent }, breakLine: true, paraSpaceAfter: 8 } })),
      { x: W * 0.07, y: H * 0.27, w: W * 0.86, h: H * 0.6, fontFace: f.minor, fontSize: 20, color: ink.body, valign: "top", lineSpacingMultiple: 1.35 }
    );
  }
  drawFooter(slide, ctx);
}
