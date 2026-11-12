import { textUnits } from "@lot-agent/core/presentation";
import type { PptSlide } from "../renderer.js";
import { fitRows, textHeight } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, drawCard, drawFooter, drawHeading, inkColors, pageBackground, palette, settle } from "./ctx.js";

const valueSize = (values: string[], w: number) => {
  const units = Math.max(...values.map(v => textUnits(v)));
  const preferred = units <= 4 ? 54 : units <= 6 ? 46 : units <= 9 ? 38 : 32;
  return Math.min(preferred, Math.max(18, Math.floor((w - 0.22) * 72 / Math.max(1, units))));
};

/** Headline metrics: an open row with dividers, or a hero metric beside the rest on repeated use. */
export function buildStats(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { f } = ctx;
  const hasBg = pageBackground(slide, ctx);
  const p = palette(ctx);
  const frame = drawHeading(slide, s.title, ctx);
  const items = s.items ?? [];
  const n = items.length;
  const available = frame.bottom - frame.top;

  if (n >= 2 && (ctx.occurrence ?? 0) % 2 === 1) {
    const heroW = frame.w * 0.4, gap = 0.5;
    const restX = frame.x + heroW + gap, restW = frame.w - heroW - gap;
    const [hero, ...rest] = items;
    const heroInner = heroW - 0.8;
    const heroSize = valueSize([hero.value ?? ""], heroInner);
    const heroValueH = textHeight(hero.value ?? "", heroSize, heroInner);
    const heroLabelH = textHeight(hero.label, 18, heroInner);
    const heroDescH = hero.desc ? textHeight(hero.desc, 14, heroInner) + 0.15 : 0;
    const heroH = heroValueH + heroLabelH + heroDescH + 0.2;
    const valueW = restW * 0.4, textW = restW * 0.55;
    const measure = (size: number) => rest.map(it => {
      const labelH = textHeight(it.label, size, textW);
      const descH = it.desc ? textHeight(it.desc, size - 3, textW) : 0;
      const valueH = textHeight(it.value ?? "", size + 10, valueW);
      return Math.max(valueH, labelH + descH) + 0.18;
    });
    const fit = fitRows(measure, available, [17, 15, 13, 11], 0.12, 0.28);
    const total = Math.max(heroH + 0.62, fit.total, 2.65);
    const restInk = inkColors(ctx);
    if (total <= available) {
      const y = settle(frame, total);
      const ink = drawCard(slide, ctx, { x: frame.x, y, w: heroW, h: total }, true);
      const x = frame.x + 0.4;
      const top = y + (total - heroH) / 2;
      slide.addText(hero.value ?? "", { x, y: top, w: heroInner, h: heroValueH, fontFace: f.major, fontSize: heroSize, bold: true, color: ink.title });
      const labelY = top + heroValueH + 0.2;
      slide.addText(hero.label, { x, y: labelY, w: heroInner, h: heroLabelH, fontFace: f.major, fontSize: 18, bold: true, color: ink.title });
      if (hero.desc) slide.addText(hero.desc, {
        x, y: labelY + heroLabelH + 0.15, w: heroInner, h: heroDescH - 0.15, fontFace: f.minor, fontSize: 14, color: ink.body,
      });
      let ry = y + (total - fit.total) / 2;
      rest.forEach((it, i) => {
        const h = fit.rows[i];
        const labelH = textHeight(it.label, fit.size, textW);
        const descH = it.desc ? textHeight(it.desc, fit.size - 3, textW) : 0;
        const labelY = ry + (h - labelH - descH) / 2;
        const textX = restX + restW * 0.45;
        slide.addText(it.value ?? "", {
          x: restX, y: ry, w: valueW, h, fontFace: f.major, fontSize: fit.size + 10, bold: true, color: restInk.onBg ? restInk.title : p.accent,
        });
        slide.addText(it.label, { x: textX, y: labelY, w: textW, h: labelH, fontFace: f.major, fontSize: fit.size, bold: true, color: restInk.title });
        if (it.desc) slide.addText(it.desc, {
          x: textX, y: labelY + labelH, w: textW, h: descH, fontFace: f.minor, fontSize: fit.size - 3, color: restInk.body,
        });
        if (i < rest.length - 1) slide.addShape("line", { x: restX, y: ry + h, w: restW, h: 0, line: { color: p.line, width: 0.75 } });
        ry += h + fit.gap;
      });
      drawFooter(slide, ctx);
      return;
    }
  }

  const gap = 0.3;
  const colW = (frame.w - gap * (n - 1)) / n;
  const pad = 0.2, inner = colW - pad * 2;
  const values = items.map(it => it.value ?? "");
  const preferred = valueSize(values, inner);
  const measure = (size: number) => ({
    valueH: Math.max(...values.map(value => textHeight(value, Math.min(preferred, size * 3), inner))),
    labelH: Math.max(...items.map(it => textHeight(it.label, size, inner))),
    descH: Math.max(0, ...items.map(it => it.desc ? textHeight(it.desc, size - 3, inner, 1.1) : 0)),
  });
  const blockHeight = ({ valueH, labelH, descH }: ReturnType<typeof measure>) => valueH + 0.15 + labelH + (descH ? 0.1 + descH : 0);
  const padding = hasBg ? 0.6 : 0.36;
  const size = [18, 16, 14, 12, 11, 10, 9].find(n => blockHeight(measure(n)) + padding <= available) ?? 9;
  const { valueH, labelH, descH } = measure(size);
  const total = blockHeight({ valueH, labelH, descH }) + padding;
  const y = settle(frame, total);
  items.forEach((it, i) => {
    const x = frame.x + i * (colW + gap);
    const ink = hasBg ? drawCard(slide, ctx, { x, y, w: colW, h: total }) : inkColors(ctx);
    const ty = y + padding / 2;
    const common = { x: x + pad, w: inner, align: "center", valign: "top" };
    slide.addText(it.value ?? "", {
      ...common, y: ty, h: valueH, fontFace: f.major, fontSize: Math.min(preferred, size * 3), bold: true, color: hasBg ? ink.title : p.accent,
    });
    slide.addText(it.label, { ...common, y: ty + valueH + 0.15, h: labelH, fontFace: f.major, fontSize: size, bold: true, color: ink.title });
    if (it.desc) slide.addText(it.desc, {
      ...common, y: ty + valueH + 0.25 + labelH, h: descH, fontFace: f.minor, fontSize: size - 3, color: ink.body, lineSpacingMultiple: 1.1,
    });
    if (!hasBg && i < n - 1) slide.addShape("line", { x: x + colW + gap / 2, y: y + 0.2, w: 0, h: total - 0.4, line: { color: p.line, width: 0.75 } });
  });
  if (!hasBg) slide.addShape("line", { x: frame.x, y: y - 0.05, w: frame.w, h: 0, line: { color: p.accent, width: 1.5 } });
  drawFooter(slide, ctx);
}
