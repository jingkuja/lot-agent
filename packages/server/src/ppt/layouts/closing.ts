import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, darken } from "./ctx.js";

export function buildClosing(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.accent1 };
  slide.addShape("rect", { x: 0, y: 0, w: W, h: H, fill: { type: "gradient", gradientType: "linear", angle: 135, stops: [{ color: c.accent1, position: 0 }, { color: darken(c.accent1, 0.25), position: 100 }] } });
  slide.addShape("ellipse", { x: -W * 0.06, y: H * 0.68, w: H * 0.4, h: H * 0.4, fill: { color: "FFFFFF", transparency: 88 } });
  slide.addText(s.title, { x: W * 0.08, y: H * 0.38, w: W * 0.84, h: H * 0.2, fontFace: f.major, fontSize: 40, bold: true, color: c.lt1, align: "center" });
  if (s.subtitle) slide.addText(s.subtitle, { x: W * 0.08, y: H * 0.6, w: W * 0.84, h: H * 0.1, fontFace: f.minor, fontSize: 16, color: c.lt2, align: "center" });
}
