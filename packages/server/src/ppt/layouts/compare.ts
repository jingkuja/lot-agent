import type { PptSlide, PptColumn } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter, applyBackground, inkColors } from "./ctx.js";

export function buildCompare(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addText(s.title, { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: ink.title });
  const colW = W * 0.42;
  const col = (column: PptColumn, x: number, accentIdx: number) => {
    const accent = accentAt(c, accentIdx);
    slide.addShape("roundRect", { x, y: H * 0.26, w: colW, h: H * 0.62, rectRadius: 0.08, fill: { color: c.lt1 }, line: { color: c.lt2, width: 1 } });
    slide.addShape("rect", { x, y: H * 0.26, w: colW, h: H * 0.1, fill: { color: accent } });
    slide.addText(column.title, { x: x + 0.2, y: H * 0.26, w: colW - 0.4, h: H * 0.1, fontFace: f.major, fontSize: 18, bold: true, color: "FFFFFF", valign: "middle" });
    slide.addText(
      column.bullets.map((b) => ({ text: b, options: { bullet: { color: accent }, breakLine: true, paraSpaceAfter: 8 } })),
      { x: x + 0.25, y: H * 0.4, w: colW - 0.5, h: H * 0.44, fontFace: f.minor, fontSize: 14, color: c.dk2, valign: "top", lineSpacingMultiple: 1.3 }
    );
  };
  col(s.left!, W * 0.06, 0);
  col(s.right!, W * 0.52, 3);
  drawFooter(slide, ctx);
}
