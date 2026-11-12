import { PPT_DEFAULT_STYLE, type PptThemeStyle } from "@lot-agent/core/presentation";
import type { PptTheme } from "../theme-extractor.js";
import type { PptLayout } from "../renderer.js";
import { textHeight } from "../text-fit.js";

export type PptxSlide = any;

export interface BuildCtx {
  c: PptTheme["colors"];
  f: PptTheme["fonts"];
  W: number;
  H: number;
  theme: PptTheme;
  index: number;   // 0-based
  total: number;
  presTitle: string;
  /** 供 agenda 版式：缺省 items 时用后续 section 标题填充。 */
  agendaItems?: string[];
  layout: PptLayout;
  /** How many earlier slides use the same layout; picks the variant so repeated layouts alternate. */
  occurrence?: number;
}

const channels = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = (values: number[]) => values.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** Linear blend from `a` (t=0) to `b` (t=1). */
export function mix(a: string, b: string, t: number): string {
  const x = channels(a), y = channels(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

function luminance(hex: string): number {
  const values = channels(hex).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const isDark = (hex: string) => luminance(hex) < 0.18;

export function contrastInk(hex: string): string {
  return luminance(hex) > 0.179 ? "000000" : "FFFFFF";
}

/** Keeps a theme color when it is legible on `bg`, otherwise falls back to a contrasting ink. */
function readable(color: string, bg: string, min = 4): string {
  return contrastRatio(color, bg) >= min ? color : contrastInk(bg);
}

export function styleOf(ctx: BuildCtx): PptThemeStyle {
  return ctx.theme.style ?? PPT_DEFAULT_STYLE;
}

export interface Palette {
  page: string;
  surface: string;
  accent: string;
  /** Accent tint on the page, for soft panels and highlights. */
  soft: string;
  line: string;
  /** De-emphasized text and secondary data. */
  muted: string;
  onAccent: string;
  title: string;
  body: string;
  dark: boolean;
}

/** One emphasis color plus neutrals derived from the page, so every theme and extracted template stays consistent. */
export function palette(ctx: BuildCtx): Palette {
  const { c } = ctx;
  const page = c.lt2;
  const dark = isDark(page);
  const surface = dark ? (isDark(c.lt1) ? c.lt1 : mix(page, "FFFFFF", 0.06)) : (isDark(c.lt1) ? "FFFFFF" : c.lt1);
  const title = readable(c.dk1, page, 7);
  const body = readable(c.dk2, page, 4.5);
  const accent = contrastRatio(c.accent1, page) >= 2 ? c.accent1 : title;
  return {
    page, surface, accent, dark, title, body,
    soft: mix(page, accent, dark ? 0.16 : 0.08),
    line: mix(page, body, dark ? 0.28 : 0.2),
    muted: mix(page, body, 0.7),
    onAccent: contrastInk(accent),
  };
}

/** Series colors keep one accent and step through neutrals, instead of a rainbow. */
export function seriesColors(ctx: BuildCtx, count: number): string[] {
  const p = palette(ctx);
  const base = [p.accent, mix(p.page, p.body, 0.45), mix(p.page, p.accent, 0.45), mix(p.page, p.body, 0.25)];
  if (count <= base.length) return base.slice(0, count);
  return Array.from({ length: count }, (_, i) => mix(p.accent, p.page, Math.min(0.85, i / count)));
}

export function bgRoleFor(layout: PptLayout): "cover" | "section" | "body" {
  if (layout === "cover" || layout === "closing") return "cover";
  if (layout === "section") return "section";
  return "body";
}

/** 若主题为该版式配了背景图：贴整页图 + 遮罩，返回 true（否则不动 slide.background）。 */
export function applyBackground(slide: PptxSlide, ctx: BuildCtx): boolean {
  const bg = ctx.theme.backgrounds?.[bgRoleFor(ctx.layout)];
  if (!bg) return false;
  const b64 = bg.image.toString("base64");
  const mime = bg.ext === "jpeg" ? "image/jpeg" : "image/png";
  slide.background = { data: `data:${mime};base64,${b64}` };
  if (bg.overlay !== "none") {
    const dark = bg.overlay === "dark";
    slide.addShape("rect", { x: 0, y: 0, w: ctx.W, h: ctx.H, fill: { color: dark ? "000000" : "FFFFFF", transparency: dark ? 45 : 25 }, line: { type: "none" } });
  }
  return true;
}

/** 文字色：贴了深遮罩（或无 overlay 的背景）→ 白字；浅遮罩/无背景 → 主题深色。 */
export function inkColors(ctx: BuildCtx): { title: string; body: string; onBg: boolean } {
  const bg = ctx.theme.backgrounds?.[bgRoleFor(ctx.layout)];
  if (bg && bg.overlay !== "light") return { title: "FFFFFF", body: "F0F0F5", onBg: true };
  if (bg) return { title: readable(ctx.c.dk1, "FFFFFF", 7), body: readable(ctx.c.dk2, "FFFFFF", 4.5), onBg: true };
  const p = palette(ctx);
  return { title: p.title, body: p.body, onBg: false };
}

/** Page background for body layouts; returns true when an uploaded background is used. */
export function pageBackground(slide: PptxSlide, ctx: BuildCtx): boolean {
  if (applyBackground(slide, ctx)) return true;
  slide.background = { color: palette(ctx).page };
  return false;
}

export const MARGIN_X = 0.75;
export interface Frame { x: number; w: number; top: number; bottom: number }

/** Draws the title in the theme's heading style and returns the body frame below it. */
export function drawHeading(slide: PptxSlide, title: string, ctx: BuildCtx, area?: { x: number; w: number }): Frame {
  const { f, W, H, index } = ctx;
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const style = styleOf(ctx).heading;
  const x = area?.x ?? MARGIN_X, w = area?.w ?? W - MARGIN_X * 2;
  let y = 0.62;
  if (style === "bar") {
    slide.addShape("rect", { x, y, w: 0.42, h: 0.07, fill: { color: p.accent }, line: { type: "none" } });
    y += 0.2;
  } else if (style === "eyebrow") {
    slide.addText(String(index + 1).padStart(2, "0"), { x, y: y - 0.04, w: 0.6, h: 0.26, fontFace: f.minor, fontSize: 11, bold: true, color: p.accent });
    slide.addShape("line", { x: x + 0.48, y: y + 0.09, w: 0.5, h: 0, line: { color: p.accent, width: 1 } });
    y += 0.3;
  }
  const maxH = area ? 2.25 : 1.4;
  let size = style === "plain" ? 30 : 28;
  while (size > 16 && textHeight(title, size, w) > maxH) size -= 2;
  const h = Math.min(textHeight(title, size, w), maxH);
  slide.addText(title, { x, y, w, h, fontFace: f.major, fontSize: size, bold: true, color: ink.title, valign: "top" });
  y += h;
  if (style === "rule" || style === "underline") {
    const full = style === "rule";
    slide.addShape("line", { x, y: y + 0.14, w: full ? w : 0.82, h: 0, line: { color: full ? p.line : p.accent, width: full ? 0.75 : 2 } });
    y += 0.14;
  }
  return { x, w, top: y + 0.42, bottom: H - 1.0 };
}

/** Starting y that places a block of height `h` in the frame, slightly above center. */
export function settle(frame: Frame, h: number): number {
  const spare = frame.bottom - frame.top - h;
  return frame.top + Math.max(0, spare * 0.38);
}

export interface CardInk { title: string; body: string }

/** Draws a card in the theme's card treatment and returns the text colors to use inside it. */
export function drawCard(slide: PptxSlide, ctx: BuildCtx, box: { x: number; y: number; w: number; h: number }, emphasis = false): CardInk {
  const p = palette(ctx);
  const hasBg = !!ctx.theme.backgrounds?.body && bgRoleFor(ctx.layout) === "body";
  const style = hasBg ? "outline" : styleOf(ctx).card;
  if (emphasis) {
    slide.addShape("roundRect", { ...box, rectRadius: 0.06, fill: { color: p.accent }, line: { type: "none" } });
    return { title: p.onAccent, body: p.onAccent };
  }
  if (style === "rule") {
    slide.addShape("line", { x: box.x, y: box.y, w: box.w, h: 0, line: { color: p.title, width: 1.5 } });
    const ink = inkColors(ctx);
    return { title: ink.title, body: ink.body };
  }
  const fill = style === "soft" ? p.soft : p.surface;
  const options: Record<string, unknown> = { ...box, rectRadius: 0.06, fill: { color: fill } };
  options.line = style === "outline" ? { color: p.line, width: 0.75 } : { type: "none" };
  if (style === "raised") options.shadow = { type: "outer", color: "000000", opacity: 0.1, blur: 10, offset: 3, angle: 90 };
  slide.addShape(style === "left-rule" ? "rect" : "roundRect", options);
  if (style === "left-rule") {
    slide.addShape("rect", { x: box.x, y: box.y, w: 0.05, h: box.h, fill: { color: p.accent }, line: { type: "none" } });
  }
  return { title: readable(ctx.c.dk1, fill, 7), body: readable(ctx.c.dk2, fill, 4.5) };
}

/** Body pages: deck title on the left and the page number on the right, without a heavy rule. */
export function drawFooter(slide: PptxSlide, ctx: BuildCtx): void {
  const { f, W, H, index, total, presTitle } = ctx;
  const ink = inkColors(ctx);
  const color = ink.onBg ? ink.body : palette(ctx).muted;
  slide.addText(presTitle, { x: MARGIN_X, y: H - 0.5, w: W * 0.6, h: 0.28, fontFace: f.minor, fontSize: 9, color, valign: "middle" });
  slide.addText(`${index + 1} / ${total}`, {
    x: W - MARGIN_X - 1.6, y: H - 0.5, w: 1.6, h: 0.28, fontFace: f.minor, fontSize: 9, color, align: "right", valign: "middle",
  });
}

export function drawSource(slide: PptxSlide, source: string | undefined, ctx: BuildCtx, color = inkColors(ctx).body, w = ctx.W - 2 * MARGIN_X): void {
  if (!source) return;
  const size = [9, 8, 7].find(size => textHeight(source, size, w) <= 0.46) ?? 7;
  slide.addText(source, {
    x: MARGIN_X, y: ctx.H - 0.98, w, h: 0.46, fontSize: size, fontFace: ctx.f.minor, color, valign: "top",
  });
}
