import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, darken, applyBackground, inkColors } from "./ctx.js";

export function buildCover(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) {
    const bottom = darken(c.accent1, 0.2);
    slide.background = { color: c.accent1 };
    slide.addShape("rect", {
      x: 0, y: 0, w: W, h: H,
      fill: { type: "gradient", gradientType: "linear", angle: 135, stops: [{ color: c.accent1, position: 0 }, { color: bottom, position: 100 }] },
    });
    slide.addShape("ellipse", { x: W * 0.72, y: -H * 0.18, w: H * 0.65, h: H * 0.65, fill: { color: "FFFFFF", transparency: 90 } });
    slide.addShape("ellipse", { x: -W * 0.06, y: H * 0.72, w: H * 0.35, h: H * 0.35, fill: { color: "FFFFFF", transparency: 88 } });
  }
  // 自绘渐变恒为深色底，保持白字；贴了背景图时按 overlay 实际反色（light/none 遮罩下需深色字）
  const ink = hasBg ? inkColors(ctx) : { title: c.lt1, body: c.lt2 };
  slide.addText(s.title, { x: W * 0.08, y: H * 0.32, w: W * 0.84, h: H * 0.24, fontFace: f.major, fontSize: 42, bold: true, color: ink.title });
  const sub = s.subtitle ?? s.bullets?.join("  ·  ");
  if (sub) slide.addText(sub, { x: W * 0.08, y: H * 0.6, w: W * 0.84, h: H * 0.12, fontFace: f.minor, fontSize: 16, color: ink.body });
}
