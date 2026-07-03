import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, darken } from "./ctx.js";

export function buildQuote(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index } = ctx;
  const accent = accentAt(c, index);
  slide.background = { color: c.dk1 };
  slide.addShape("rect", { x: 0, y: 0, w: W, h: H, fill: { type: "gradient", gradientType: "linear", angle: 135, stops: [{ color: c.dk1, position: 0 }, { color: darken(c.dk1, 0.25), position: 100 }] } });
  slide.addText("“", { x: W * 0.08, y: H * 0.14, w: W * 0.2, h: H * 0.3, fontFace: f.major, fontSize: 120, bold: true, color: accent });
  slide.addText(s.quote?.text ?? "", { x: W * 0.12, y: H * 0.34, w: W * 0.76, h: H * 0.34, fontFace: f.major, fontSize: 30, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
  if (s.quote?.author) slide.addText(`— ${s.quote.author}`, { x: W * 0.12, y: H * 0.72, w: W * 0.76, h: H * 0.1, fontFace: f.minor, fontSize: 16, color: c.lt2, align: "center" });
}
