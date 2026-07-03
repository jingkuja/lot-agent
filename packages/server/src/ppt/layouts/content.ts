import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildContent(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index } = ctx;
  const accent = accentAt(c, index);
  slide.background = { color: c.lt2 };
  slide.addShape("rect", { x: 0, y: 0, w: W, h: 0.07, fill: { color: accent } });
  slide.addText(s.title, { x: W * 0.06, y: H * 0.07, w: W * 0.88, h: H * 0.13, fontFace: f.major, fontSize: 28, bold: true, color: c.dk1 });
  slide.addShape("rect", { x: W * 0.06, y: H * 0.2, w: W * 0.14, h: 0.04, fill: { color: accent } });
  if (s.bullets?.length) {
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: { color: accent }, breakLine: true, paraSpaceAfter: 8 } })),
      { x: W * 0.07, y: H * 0.27, w: W * 0.86, h: H * 0.6, fontFace: f.minor, fontSize: 16, color: c.dk2, valign: "top", lineSpacingMultiple: 1.35 }
    );
  }
  drawFooter(slide, ctx);
}
