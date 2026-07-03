import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter, applyBackground, inkColors } from "./ctx.js";

export function buildAgenda(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  slide.addText(s.title, { x: W * 0.06, y: H * 0.1, w: W * 0.88, h: H * 0.14, fontFace: f.major, fontSize: 32, bold: true, color: ink.title });
  slide.addShape("rect", { x: W * 0.06, y: H * 0.24, w: W * 0.14, h: 0.05, fill: { color: accentAt(c, 0) } });
  const labels = (s.items?.map((it) => it.label) ?? ctx.agendaItems ?? []).slice(0, 10);
  labels.forEach((label, i) => {
    const accent = accentAt(c, i);
    const y = H * 0.34 + i * (H * 0.56 / Math.max(labels.length, 1));
    slide.addShape("ellipse", { x: W * 0.08, y, w: 0.4, h: 0.4, fill: { color: accent } });
    slide.addText(`${i + 1}`, { x: W * 0.08, y, w: 0.4, h: 0.4, fontFace: f.major, fontSize: 14, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    slide.addText(label, { x: W * 0.16, y, w: W * 0.76, h: 0.4, fontFace: f.minor, fontSize: 18, color: ink.title, valign: "middle" });
  });
  drawFooter(slide, ctx);
}
