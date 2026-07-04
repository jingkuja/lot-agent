import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter, applyBackground, inkColors } from "./ctx.js";

export function buildTimeline(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addText(s.title, { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: ink.title });
  const items = s.items ?? [];
  const n = items.length;
  const y = H * 0.5;
  slide.addShape("line", { x: W * 0.08, y, w: W * 0.84, h: 0, line: { color: c.dk2, width: 1.5, transparency: 40 } });
  const step = (W * 0.84) / (n - 1 || 1);
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const x = W * 0.08 + i * step;
    slide.addShape("ellipse", { x: x - 0.12, y: y - 0.12, w: 0.24, h: 0.24, fill: { color: accent }, line: { color: "FFFFFF", width: 2 } });
    const up = i % 2 === 0;
    slide.addText(`${i + 1}`, { x: x - 0.12, y: y - 0.12, w: 0.24, h: 0.24, fontFace: f.major, fontSize: 11, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    slide.addText(it.label, { x: x - step * 0.45, y: up ? y - H * 0.22 : y + H * 0.06, w: step * 0.9, h: H * 0.1, fontFace: f.major, fontSize: 14, bold: true, color: ink.title, align: "center" });
    if (it.desc) slide.addText(it.desc, { x: x - step * 0.45, y: up ? y - H * 0.12 : y + H * 0.16, w: step * 0.9, h: H * 0.1, fontFace: f.minor, fontSize: 11, color: ink.body, align: "center" });
  });
  drawFooter(slide, ctx);
}
