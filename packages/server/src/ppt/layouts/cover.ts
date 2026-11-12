import { textUnits } from "@lot-agent/core/presentation";
import type { PptSlide } from "../renderer.js";
import { linesFor, textHeight } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, applyBackground, contrastInk, drawSource, inkColors, mix, palette, styleOf } from "./ctx.js";

interface Ink { title: string; body: string }
interface Block { x: number; w: number; centerY: number; align: "left" | "center"; ink: Ink }

/** Title and subtitle stacked around `centerY`; the title shrinks before it exceeds three lines. */
function drawStatement(slide: PptxSlide, s: PptSlide, ctx: BuildCtx, block: Block, maxSize: number): { top: number; bottom: number } {
  const { f } = ctx;
  const sub = s.subtitle ?? s.bullets?.join("  ·  ");
  const available = Math.min(block.centerY - 0.55, ctx.H - 1.02 - block.centerY) * 2;
  const singleLineSize = Math.floor((block.w - 0.3) * 72 / Math.max(1, textUnits(s.title)));
  let size = !s.title.includes("\n") && singleLineSize >= maxSize - 8 ? Math.min(maxSize, singleLineSize) : maxSize;
  let subSize = 16;
  let titleH = textHeight(s.title, size, block.w, 1.05);
  let subH = sub ? textHeight(sub, subSize, block.w, 1.15) : 0;
  const gap = sub ? 0.3 : 0;
  while (size > 22 && (linesFor(s.title, size, block.w) > 3 || titleH + gap + subH > available)) {
    size -= 2;
    if (sub && subSize > 11 && titleH + gap + subH > available) subH = textHeight(sub, --subSize, block.w, 1.15);
    titleH = textHeight(s.title, size, block.w, 1.05);
  }
  if (sub) subH = Math.min(subH, available - titleH - gap);
  const total = titleH + gap + subH;
  const top = block.centerY - total / 2;
  const common = { x: block.x, w: block.w, align: block.align, valign: "top" };
  slide.addText(s.title, { ...common, y: top, h: titleH, fontFace: f.major, fontSize: size, bold: true, color: block.ink.title, lineSpacingMultiple: 1.05 });
  if (sub) slide.addText(sub, {
    ...common, y: top + titleH + gap, h: subH, fontFace: f.minor, fontSize: subSize, color: block.ink.body, lineSpacingMultiple: 1.15,
  });
  return { top, bottom: top + total };
}

/** Cover and closing share one composition per theme; the closing centers its call to action. */
function buildStatementPage(slide: PptxSlide, s: PptSlide, ctx: BuildCtx, closing: boolean): string {
  const { W, H } = ctx;
  const p = palette(ctx);
  if (applyBackground(slide, ctx)) {
    const ink = inkColors(ctx);
    drawStatement(slide, s, ctx, { x: 0.9, w: W - 1.8, centerY: H * 0.46, align: closing ? "center" : "left", ink }, 40);
    return ink.body;
  }
  const align = closing ? "center" : "left";
  const shape = (type: string, options: Record<string, unknown>) => slide.addShape(type, { line: { type: "none" }, ...options });
  switch (styleOf(ctx).cover) {
    case "spotlight": {
      slide.background = { color: p.page };
      const grid = mix(p.page, p.body, 0.07);
      for (let x = 1.1; x < W; x += 1.1) shape("line", { x, y: 0, w: 0, h: H, line: { color: grid, width: 0.5 } });
      for (let y = 1.25; y < H; y += 1.25) shape("line", { x: 0, y, w: W, h: 0, line: { color: grid, width: 0.5 } });
      const ring = Math.min(W * 0.32, H * 0.57);
      shape("ellipse", { x: W - ring - 0.65, y: 0.65, w: ring, h: ring, fill: { color: p.accent, transparency: 92 } });
      shape("ellipse", {
        x: W - ring * 0.8 - 0.65, y: 0.65 + ring * 0.2, w: ring * 0.6, h: ring * 0.6,
        fill: { color: p.page, transparency: 100 }, line: { color: mix(p.page, p.accent, 0.5), width: 1 },
      });
      const x = closing ? 1.5 : 1.25, w = closing ? W - 3 : W * 0.6;
      const box = drawStatement(slide, s, ctx, { x, w, centerY: H * 0.48, align, ink: { title: p.title, body: p.body } }, 40);
      if (!closing) shape("rect", { x: 0.9, y: box.top + 0.06, w: 0.07, h: box.bottom - box.top - 0.06, fill: { color: p.accent } });
      else shape("rect", { x: W / 2 - 0.3, y: box.top - 0.45, w: 0.6, h: 0.06, fill: { color: p.accent } });
      return p.body;
    }
    case "band": {
      slide.background = { color: closing ? p.accent : p.page };
      if (closing) {
        shape("ellipse", { x: W - 2.6, y: H - 2.4, w: 1.6, h: 1.6, fill: { color: mix(p.accent, "FFFFFF", 0.2) } });
        drawStatement(slide, s, ctx, { x: 1.2, w: W - 2.4, centerY: H * 0.46, align, ink: { title: p.onAccent, body: p.onAccent } }, 40);
        return p.onAccent;
      }
      const sub = s.subtitle ?? s.bullets?.join("  ·  ");
      const w = W - 4.1;
      const subH = sub ? textHeight(sub, 16, w, 1.1) : 0;
      const bandY = Math.max(H * 0.48, Math.min(H * 0.64, H - 1.55 - subH));
      shape("rect", { x: 0, y: bandY, w: W, h: H - bandY, fill: { color: p.accent } });
      shape("ellipse", { x: W - 3.4, y: bandY - 1.15, w: 2.3, h: 2.3, fill: { color: mix(p.accent, "FFFFFF", 0.35) } });
      const title = { ...s, subtitle: undefined, bullets: undefined };
      drawStatement(slide, title, ctx, { x: 0.9, w, centerY: bandY * 0.55, align, ink: { title: p.title, body: p.body } }, 42);
      if (sub) slide.addText(sub, {
        x: 0.9, y: bandY + 0.45, w, h: Math.min(subH, H - bandY - 1.5),
        fontFace: ctx.f.minor, fontSize: 16, color: p.onAccent, valign: "top", lineSpacingMultiple: 1.1,
      });
      return p.onAccent;
    }
    case "editorial": {
      const bg = closing ? p.title : p.page;
      const ink = closing ? { title: contrastInk(bg), body: mix(contrastInk(bg), bg, 0.3) } : { title: p.title, body: p.body };
      slide.background = { color: bg };
      const box = drawStatement(slide, s, ctx, { x: 0.9, w: W - 1.8, centerY: H * 0.5, align, ink }, 44);
      const ruleX = closing ? W / 2 - 0.5 : 0.9;
      shape("rect", { x: ruleX, y: box.top - 0.45, w: 1.0, h: 0.1, fill: { color: ink.title } });
      if (!closing) shape("line", { x: 0.9, y: H - 0.9, w: W - 1.8, h: 0, line: { color: p.line, width: 0.75 } });
      return ink.body;
    }
    case "frame": {
      slide.background = { color: p.page };
      shape("rect", { x: 0, y: 0, w: 0.42, h: H, fill: { color: p.accent } });
      shape("rect", { x: 0.85, y: 0.6, w: W - 1.45, h: H - 1.2, fill: { color: p.page, transparency: 100 }, line: { color: p.line, width: 0.75 } });
      const x = closing ? 1.6 : 1.45, w = closing ? W - 3.0 : W - 3.4;
      const box = drawStatement(slide, s, ctx, { x, w, centerY: H * 0.48, align, ink: { title: p.title, body: p.body } }, 38);
      const ruleX = closing ? x + w / 2 - 0.35 : x;
      shape("rect", { x: ruleX, y: box.top - 0.4, w: 0.7, h: 0.06, fill: { color: p.accent } });
      return p.body;
    }
    default: {
      // split: a deep panel carries the title; the open side holds a quiet bar motif.
      const deep = mix(ctx.c.dk1, "000000", 0.05);
      const ink = { title: contrastInk(deep), body: mix(contrastInk(deep), deep, 0.25) };
      slide.background = { color: p.page };
      if (closing) {
        shape("rect", { x: 0, y: 0, w: W, h: H, fill: { color: deep } });
        shape("rect", { x: 0, y: H - 0.12, w: W, h: 0.12, fill: { color: p.accent } });
        const box = drawStatement(slide, s, ctx, { x: 1.2, w: W - 2.4, centerY: H * 0.47, align, ink }, 40);
        shape("rect", { x: W / 2 - 0.3, y: box.top - 0.45, w: 0.6, h: 0.07, fill: { color: p.accent } });
        return ink.body;
      }
      const panelW = W * 0.62;
      shape("rect", { x: 0, y: 0, w: panelW, h: H, fill: { color: deep } });
      shape("rect", { x: panelW, y: 0, w: 0.12, h: H, fill: { color: p.accent } });
      [1, 0.73, 0.47].forEach((ratio, i) => shape("roundRect", {
        x: panelW + 0.65, y: H * 0.4 + i * 0.55, w: (W - panelW - 1.3) * ratio, h: 0.3,
        rectRadius: 0.15, fill: { color: mix(p.accent, p.page, i * 0.32) },
      }));
      const box = drawStatement(slide, s, ctx, { x: 0.9, w: panelW - 1.7, centerY: H * 0.48, align, ink }, 40);
      shape("rect", { x: 0.9, y: box.top - 0.45, w: 0.6, h: 0.07, fill: { color: p.accent } });
      return ink.body;
    }
  }
}

export function buildCover(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const split = !ctx.theme.backgrounds?.cover && styleOf(ctx).cover === "split";
  drawSource(slide, s.source, ctx, buildStatementPage(slide, s, ctx, false), split ? ctx.W * 0.62 - 1.5 : undefined);
}

export function buildClosing(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  drawSource(slide, s.source, ctx, buildStatementPage(slide, s, ctx, true));
}
