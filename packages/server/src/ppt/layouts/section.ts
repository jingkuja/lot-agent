import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, darken, accentAt, applyBackground, inkColors } from "./ctx.js";

export function buildSection(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index } = ctx;
  const accent = accentAt(c, index);
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addShape("rect", {
    x: 0, y: 0, w: W * 0.06, h: H,
    fill: { type: "gradient", gradientType: "linear", angle: 180, stops: [{ color: accent, position: 0 }, { color: darken(accent, 0.15), position: 100 }] },
  });
  slide.addShape("rect", { x: W * 0.06, y: H - 0.05, w: W * 0.94, h: 0.05, fill: { color: accent } });
  slide.addText(s.title, { x: W * 0.12, y: H * 0.33, w: W * 0.82, h: H * 0.22, fontFace: f.major, fontSize: 36, bold: true, color: ink.title });
  if (s.subtitle) slide.addText(s.subtitle, { x: W * 0.12, y: H * 0.55, w: W * 0.82, h: H * 0.12, fontFace: f.minor, fontSize: 16, color: ink.body });
}
