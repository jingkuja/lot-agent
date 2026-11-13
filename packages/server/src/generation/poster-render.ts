/**
 * Typesets a poster's wording onto its text-free background with real fonts (真实字体). Local only: sharp renders the
 * text through Pango, so there is no model request and nothing is metered. The same layout always gives the same
 * picture, which is what lets a text edit be rendered again for free.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_POSTER_STYLE, parsePosterStyle, posterHasText, posterTemplateFor, titleLineOptions,
  type PosterLayout, type PosterTemplate } from "@lot-agent/core/poster";

/** Both families and weights ship on the server, never as browser fonts. */
export const POSTER_FONT_FAMILY = "Noto Sans SC";
const FONT_FILES = ["NotoSansSC-Regular.otf", "NotoSansSC-Bold.otf", "NotoSerifSC-Regular.otf", "NotoSerifSC-Bold.otf"];

function findFontDirectory(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "assets", "fonts");
    if (FONT_FILES.every((file) => existsSync(join(candidate, file)))) return candidate;
    dir = dirname(dir);
  }
  const fromCwd = resolve(process.cwd(), "assets", "fonts");
  return FONT_FILES.every((file) => existsSync(join(fromCwd, file))) ? fromCwd : null;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Register the bundled primary fonts with system fallback before the first Pango render.
 * An operator's own FONTCONFIG_FILE is left alone; importing this module has no environment side effects.
 */
export function initializePosterFonts(): string | null {
  const fonts = findFontDirectory();
  if (!fonts || process.env.FONTCONFIG_FILE) return fonts;
  try {
    const dir = join(tmpdir(), `lot-agent-fonts-${createHash("sha256").update(fonts).digest("hex").slice(0, 12)}`);
    mkdirSync(join(dir, "cache"), { recursive: true });
    const file = join(dir, "fonts.conf");
    const system = ["/etc/fonts/fonts.conf", "/opt/homebrew/etc/fonts/fonts.conf", "/usr/local/etc/fonts/fonts.conf"].find(existsSync);
    const fallback = system ? `<include ignore_missing="yes">${escapeXml(system)}</include>`
      : "<dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir>";
    writeFileSync(file, `<?xml version="1.0"?>\n<fontconfig>${fallback}<dir>${escapeXml(fonts)}</dir>`
      + `<cachedir>${escapeXml(join(dir, "cache"))}</cachedir></fontconfig>\n`);
    process.env.FONTCONFIG_FILE = file;
  } catch (error) {
    console.warn("[poster.fonts] fontconfig setup failed", { errorType: (error as Error)?.name });
  }
  return fonts;
}

/** Whether the bundled fonts were found; without them a poster would be set in whatever the system offers. */
export function posterFontsAvailable(): boolean {
  return !!findFontDirectory();
}

/** Subprocesses select a font environment explicitly; never swap process globals around concurrent renders. */
export function mediaFontEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.env.MEDIA_FONTCONFIG_FILE) env.FONTCONFIG_FILE = process.env.MEDIA_FONTCONFIG_FILE;
  return env;
}

type Rgb = [number, number, number];
interface Rect { left: number; top: number; width: number; height: number }
interface Picture { data: Buffer; width: number; height: number }
type Align = "left" | "centre";

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function hex(color: Rgb): string {
  return `#${color.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * share) as Rgb;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(color: Rgb): number {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

interface Palette { panel: Rgb; text: Rgb; muted: Rgb; accent: Rgb; onAccent: Rgb }

/**
 * Colors for text on a block of `base` (the picture's own color where the panel sits): a dark picture gets a dark
 * panel with light text, a light one a pale panel with dark text, so the panel reads as part of the picture.
 */
export function posterPalette(base: Rgb): Palette {
  const dark = luminance(base) < 0.32;
  const panel = dark ? mix(base, BLACK, 0.5) : mix(base, WHITE, 0.78);
  let text = dark ? mix(base, WHITE, 0.94) : mix(base, BLACK, 0.86);
  if (contrastRatio(text, panel) < 7) text = dark ? WHITE : [20, 20, 20];
  let accent: Rgb = dark ? [255, 214, 102] : [212, 56, 13];
  if (contrastRatio(accent, panel) < 3) accent = text;
  return { panel, text, muted: mix(text, panel, 0.36), accent, onAccent: contrastRatio(WHITE, accent) >= 3 ? WHITE : [20, 20, 20] };
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.min(width - 1, Math.round(rect.left)));
  const top = Math.max(0, Math.min(height - 1, Math.round(rect.top)));
  return {
    left, top,
    width: Math.max(1, Math.min(width - left, Math.round(rect.width))),
    height: Math.max(1, Math.min(height - top, Math.round(rect.height))),
  };
}

/** Mean color of an area and how much it varies (largest per-channel standard deviation, 0–255). */
async function areaStats(background: Buffer, rect: Rect): Promise<{ mean: Rgb; spread: number }> {
  const stats = await sharp(background).extract(rect).resize(64, 64, { fit: "fill" }).removeAlpha().toColourspace("srgb").stats();
  const channels = stats.channels.slice(0, 3);
  const mean = (channels.length === 3 ? channels.map((channel) => channel.mean) : [channels[0].mean, channels[0].mean, channels[0].mean]) as Rgb;
  return { mean, spread: Math.max(...channels.map((channel) => channel.stdev)) };
}

/** Text is written into Pango markup; the user's characters must never become tags or attributes. */
export function escapeMarkup(text: string): string {
  return escapeXml(text);
}

function posterSpan(layout: PosterLayout) {
  const family = parsePosterStyle(layout.style).font === "serif" ? "Noto Serif SC" : POSTER_FONT_FAMILY;
  return (text: string, size: number, color: Rgb, bold = false, extra = ""): string => {
    const font = `${family}${bold ? " Bold" : ""} ${Math.max(8, Math.round(size))}`;
    return `<span font_desc="${font}" foreground="${hex(color)}"${extra}>${escapeMarkup(text)}</span>`;
  };
}

/** Render Pango markup to a transparent picture. `width` wraps the text; without it the text keeps its own lines. */
async function textPicture(markup: string, options: { width?: number; align?: Align; spacing?: number } = {}): Promise<Picture> {
  const { data, info } = await sharp({
    text: {
      text: markup, rgba: true, dpi: 72, align: options.align ?? "left", spacing: options.spacing ?? 0,
      ...(options.width ? { width: Math.max(1, Math.round(options.width)), wrap: "word-char" as const } : {}),
    },
  }).png().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** A price split into what is set small (currency sign, unit) and the number set large. */
export function pricePieces(price: string, cjk: boolean): { before: string; number: string; after: string } {
  const match = /^(\D*?)(\d[\d.,\s]*\d|\d)(.*)$/.exec(price);
  if (!match) return { before: "", number: price, after: "" };
  const before = match[1].trim();
  const after = match[3].trim();
  // A bare number on a Chinese poster is a yuan price.
  return { before: !before && !after && cjk ? "¥" : before, number: match[2].replace(/\s+/g, ""), after };
}

const CJK = /\p{Script=Han}/u;

interface Block { picture: Picture; gapBefore: number }

/** Several pictures side by side on one row, bottoms aligned. */
async function rowPicture(items: Picture[], gap: number): Promise<Picture> {
  if (items.length === 1) return items[0];
  const width = items.reduce((sum, item) => sum + item.width, 0) + gap * (items.length - 1);
  const height = Math.max(...items.map((item) => item.height));
  let left = 0;
  const layers = items.map((item) => {
    const layer = { input: item.data, left, top: height - item.height };
    left += item.width + gap;
    return layer;
  });
  const data = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
  return { data, width, height };
}

/** Text on a rounded block of the accent color (the discount badge). */
async function badgePicture(text: string, size: number, palette: Palette, layout: PosterLayout): Promise<Picture> {
  const span = posterSpan(layout);
  const label = await textPicture(span(text, size, palette.onAccent, true));
  const padX = Math.round(size * 0.55);
  const padY = Math.round(size * 0.28);
  const width = label.width + padX * 2;
  const height = label.height + padY * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="${width}" height="${height}" rx="${Math.round(height * 0.28)}" fill="${hex(palette.accent)}"/></svg>`;
  const data = await sharp(Buffer.from(svg)).composite([{ input: label.data, left: padX, top: padY }]).png().toBuffer();
  return { data, width, height };
}

/** Price, struck-through original price and discount badge on one row, scaled down if the row is too wide. */
async function priceRow(layout: PosterLayout, unit: number, width: number, palette: Palette): Promise<Picture | null> {
  const { fields } = layout;
  const span = posterSpan(layout);
  if (!fields.price && !fields.originalPrice && !fields.discount) return null;
  const cjk = CJK.test(`${fields.title}${fields.subtitle}${fields.points.join("")}${fields.address}`);
  const build = async (scale: number) => {
    const items: Picture[] = [];
    const big = unit * 0.92 * scale;
    if (fields.price) {
      const { before, number, after } = pricePieces(fields.price, cjk);
      const small = big * 0.5;
      items.push(await textPicture(
        (before ? span(before, small, palette.accent, true) : "") + span(number, big, palette.accent, true)
        + (after ? span(` ${after}`, small, palette.accent, true) : "")
      ));
    }
    if (fields.originalPrice) {
      const { before, number, after } = pricePieces(fields.originalPrice, cjk);
      const text = `${before}${number}${after ? ` ${after}` : ""}`;
      items.push(await textPicture(span(text, unit * 0.36 * scale, palette.muted, false, ' strikethrough="true"')));
    }
    if (fields.discount) items.push(await badgePicture(fields.discount, unit * (fields.price ? 0.34 : 0.5) * scale, palette, layout));
    return rowPicture(items, Math.round(unit * 0.22 * scale));
  };
  const row = await build(1);
  return row.width <= width ? row : build(width / row.width * 0.98);
}

/** The title at the largest size (up to `max`) at which its widest line fits `width`, over the allowed line breaks. */
async function titlePicture(layout: PosterLayout, max: number, width: number, color: Rgb, align: Align): Promise<Picture | null> {
  const span = posterSpan(layout);
  const bold = parsePosterStyle(layout.style).titleWeight === "bold";
  const title = layout.fields.title;
  if (!title) return null;
  let best: { lines: string[]; size: number } | undefined;
  for (const lines of titleLineOptions(title, layout.titleLines)) {
    const probe = await textPicture(span(lines.join("\n"), 100, color, bold));
    const size = Math.min(max, Math.floor(100 * width / probe.width));
    // More lines must buy clearly larger type to be worth the height.
    const score = size * 0.92 ** (lines.length - 1);
    if (!best || score > best.size * 0.92 ** (best.lines.length - 1)) best = { lines, size };
  }
  if (!best) return null;
  return textPicture(span(best.lines.join("\n"), best.size, color, bold), { align, spacing: Math.round(best.size * 0.12) });
}

/** Every text block of a poster stacked top to bottom for a column `width` wide, with type scaled by `scale`. */
async function buildBlocks(layout: PosterLayout, width: number, unit: number, scale: number, palette: Palette, align: Align): Promise<Block[]> {
  const span = posterSpan(layout);
  const fields = layout.fields;
  const u = unit * scale;
  const blocks: Block[] = [];
  const add = (picture: Picture | null, gap: number) => {
    if (picture) blocks.push({ picture, gapBefore: blocks.length ? Math.round(u * gap) : 0 });
  };
  add(await titlePicture(layout, u, width, palette.text, align), 0);
  if (fields.subtitle) add(await textPicture(span(fields.subtitle, u * 0.4, palette.text), { width, align, spacing: Math.round(u * 0.08) }), 0.2);
  if (fields.points.length) {
    // Centered posters run the points on one flowing line; a left-aligned column lists them.
    const markup = align === "centre"
      ? fields.points.map((point) => span(point, u * 0.34, palette.text)).join(span("  ·  ", u * 0.34, palette.accent, true))
      : fields.points.map((point) => span("• ", u * 0.34, palette.accent, true) + span(point, u * 0.34, palette.text)).join("\n");
    add(await textPicture(markup, { width, align, spacing: Math.round(u * 0.14) }), 0.3);
  }
  add(await priceRow(layout, u, width, palette), 0.3);
  const footer = [fields.date, fields.address].filter(Boolean);
  if (footer.length) {
    add(await textPicture(span(footer.join("\n"), u * 0.27, palette.muted), { width, align, spacing: Math.round(u * 0.1) }), 0.34);
  }
  return blocks;
}

function stackHeight(blocks: Block[]): number {
  return blocks.reduce((sum, block) => sum + block.gapBefore + block.picture.height, 0);
}

const MIN_SCALE = 0.42;

/** The blocks at the largest scale whose stack is no taller than `maxHeight`; `overflow` when even the smallest is. */
async function fitBlocks(layout: PosterLayout, width: number, maxHeight: number, unit: number, palette: Palette, align: Align) {
  let scale = 1;
  for (;;) {
    const blocks = await buildBlocks(layout, width, unit, scale, palette, align);
    const height = stackHeight(blocks);
    if (height <= maxHeight || scale <= MIN_SCALE) return { blocks, height, overflow: height > maxHeight };
    // Jump most of the way from the measured height, then step down until it fits.
    scale = Math.max(MIN_SCALE, Math.min(scale * 0.92, scale * Math.sqrt(maxHeight / height)));
  }
}

type Layer = { input: Buffer; left: number; top: number };

/** Composite layers for a fitted stack inside `region`, cut off at the region's bottom edge if it overflows. */
async function placeBlocks(blocks: Block[], region: Rect, align: Align, offsetTop: number): Promise<Layer[]> {
  const layers: Layer[] = [];
  let top = region.top + offsetTop;
  for (const block of blocks) {
    top += block.gapBefore;
    const { picture } = block;
    const room = region.top + region.height - top;
    if (room <= 0) break;
    const width = Math.min(picture.width, region.width);
    const height = Math.min(picture.height, room);
    const input = width < picture.width || height < picture.height
      ? await sharp(picture.data).extract({ left: 0, top: 0, width, height }).png().toBuffer()
      : picture.data;
    const left = align === "centre" ? region.left + Math.round((region.width - width) / 2) : region.left;
    layers.push({ input, left, top: Math.round(top) });
    top += picture.height;
  }
  return layers;
}

type Side = "top" | "bottom" | "left";

/** A block of color along one side of the canvas, fading into the picture over `feather` pixels. */
function panelSvg(width: number, height: number, side: Side, size: number, feather: number, color: Rgb, opacity = 1): Buffer {
  const fill = hex(color);
  // The gradient runs from the canvas edge (solid) to the inner edge of the feather (clear).
  const total = size + feather;
  const solid = (size / total).toFixed(4);
  const [x1, y1, x2, y2] = side === "top" ? [0, 0, 0, 1] : side === "bottom" ? [0, 1, 0, 0] : [0, 0, 1, 0];
  const rect = side === "top" ? `x="0" y="0" width="${width}" height="${total}"`
    : side === "bottom" ? `x="0" y="${height - total}" width="${width}" height="${total}"`
    : `x="0" y="0" width="${total}" height="${height}"`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>`
    + `<linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
    + `<stop offset="0" stop-color="${fill}" stop-opacity="${opacity}"/><stop offset="${solid}" stop-color="${fill}" stop-opacity="${opacity}"/>`
    + `<stop offset="1" stop-color="${fill}" stop-opacity="0"/></linearGradient></defs><rect ${rect} fill="url(#g)"/></svg>`
  );
}

/** A soft shadow of the text layers, so text written on a picture keeps an edge on any background. */
async function shadowLayers(layers: Layer[], color: Rgb, blur: number): Promise<Layer[]> {
  return Promise.all(layers.map(async (layer) => {
    const pad = Math.ceil(blur * 3);
    // Two steps: sharp extracts a channel at the end of a pipeline, after extend and blur would have run on all four.
    const mask = await sharp(layer.input).extractChannel("alpha").png().toBuffer();
    const alpha = await sharp(mask).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0 } })
      .blur(blur).linear(0.6, 0).toColourspace("b-w").png().toBuffer({ resolveWithObject: true });
    const fill = { r: color[0], g: color[1], b: color[2] };
    const input = await sharp({ create: { width: alpha.info.width, height: alpha.info.height, channels: 3, background: fill } })
      .joinChannel(alpha.data).png().toBuffer();
    return { input, left: layer.left - pad, top: layer.top - pad + Math.round(blur * 0.5) };
  }));
}

/** Keep layers inside the canvas: sharp refuses an overlay that sticks out. */
async function insideCanvas(layers: Layer[], width: number, height: number): Promise<Layer[]> {
  const kept: Layer[] = [];
  for (const layer of layers) {
    const meta = await sharp(layer.input).metadata();
    const left = Math.max(0, layer.left);
    const top = Math.max(0, layer.top);
    const right = Math.min(width, layer.left + (meta.width ?? 0));
    const bottom = Math.min(height, layer.top + (meta.height ?? 0));
    if (right <= left || bottom <= top) continue;
    const whole = left === layer.left && top === layer.top && right - left === meta.width && bottom - top === meta.height;
    const input = whole ? layer.input
      : await sharp(layer.input).extract({ left: left - layer.left, top: top - layer.top, width: right - left, height: bottom - top }).png().toBuffer();
    kept.push({ input, left, top });
  }
  return kept;
}

export interface RenderedPoster {
  body: Buffer;
  mime: "image/png";
  width: number;
  height: number;
  /** The template used after fitting it to the canvas shape. */
  template: PosterTemplate;
  /** The text did not fit even at the smallest size and was cut off. */
  overflow: boolean;
}

/** Largest share of the canvas a top / bottom panel may take, and the width share of a side panel. */
const PANEL_MAX_SHARE = 0.46;
const SIDE_PANEL_SHARE = 0.42;

async function panelPoster(background: Buffer, layout: PosterLayout, template: PosterTemplate, W: number, H: number) {
  const pad = Math.round(Math.min(W, H) * 0.06);
  const side: Side = template === "top_panel" ? "top" : template === "bottom_panel" ? "bottom" : "left";
  const vertical = side !== "left";
  const feather = Math.round((vertical ? H : W) * 0.07);
  const maxSize = Math.round(vertical ? H * PANEL_MAX_SHARE : W * SIDE_PANEL_SHARE);
  const columnWidth = (vertical ? W : maxSize) - pad * 2;
  const unit = Math.min(columnWidth * 0.13, Math.min(W, H) * 0.1);
  // Color comes from the picture where the panel sits, so the panel continues the picture instead of sitting on it.
  const under: Rect = side === "top" ? { left: 0, top: 0, width: W, height: maxSize }
    : side === "bottom" ? { left: 0, top: H - maxSize, width: W, height: maxSize }
    : { left: 0, top: 0, width: maxSize, height: H };
  const palette = posterPalette((await areaStats(background, clampRect(under, W, H))).mean);
  const align: Align = vertical ? "centre" : "left";
  const maxHeight = (vertical ? maxSize : H) - pad * 2;
  const fitted = await fitBlocks(layout, columnWidth, maxHeight, unit, palette, align);
  // A top / bottom panel is only as tall as its text needs; a side panel runs the full height with the text centered.
  const size = vertical ? Math.min(maxSize, Math.max(Math.round(H * 0.16), fitted.height + pad * 2)) : maxSize;
  const region: Rect = side === "top" ? { left: pad, top: pad, width: columnWidth, height: size - pad * 2 }
    : side === "bottom" ? { left: pad, top: H - size + pad, width: columnWidth, height: size - pad * 2 }
    : { left: pad, top: pad, width: columnWidth, height: H - pad * 2 };
  const offset = Math.max(0, Math.round((region.height - fitted.height) / 2));
  const layers = await placeBlocks(fitted.blocks, region, align, offset);
  const scrim = parsePosterStyle(layout.style).scrim;
  // Keep the picture visible through the upper/lower text treatment. `soft` is
  // intentionally lighter still, while `strong` preserves the opaque option.
  const opacity = scrim === "strong" ? 1 : scrim === "soft" ? 0.58 : 0.72;
  const panel = scrim === "transparent" ? [] : [{ input: panelSvg(W, H, side, size, feather, palette.panel, opacity), left: 0, top: 0 }];
  return { layers: [...panel, ...layers], overflow: fitted.overflow };
}

/** Area variation above which text written on the picture gets a scrim (0–255 standard deviation). */
const BUSY_SPREAD = 34;

async function overlayPoster(background: Buffer, layout: PosterLayout, W: number, H: number) {
  const pad = Math.round(Math.min(W, H) * 0.07);
  const columnWidth = W - pad * 2;
  const unit = Math.min(columnWidth * 0.13, Math.min(W, H) * 0.105);
  const { fields } = layout;
  const head: PosterLayout = { ...layout, fields: { ...fields, points: [], price: "", originalPrice: "", discount: "", date: "", address: "" } };
  const foot: PosterLayout = { ...layout, fields: { ...fields, title: "", subtitle: "" }, titleLines: undefined };
  const layers: Layer[] = [];
  let overflow = false;
  for (const [part, side, share] of [[head, "top", 0.36], [foot, "bottom", 0.3]] as const) {
    const maxHeight = Math.round(H * share) - pad;
    const area = clampRect({ left: 0, top: side === "top" ? 0 : H * (1 - share), width: W, height: H * share }, W, H);
    const { mean, spread } = await areaStats(background, area);
    const lightText = luminance(mean) < 0.4;
    const text: Rgb = lightText ? WHITE : [24, 24, 24];
    const palette: Palette = {
      panel: mean, text, muted: mix(text, mean, 0.18), accent: lightText ? [255, 214, 102] : [196, 44, 8], onAccent: lightText ? [24, 24, 24] : WHITE,
    };
    const fitted = await fitBlocks(part, columnWidth, maxHeight, unit, palette, "centre");
    if (!fitted.blocks.length) continue;
    overflow ||= fitted.overflow;
    const height = Math.min(fitted.height, maxHeight);
    const region: Rect = side === "top" ? { left: pad, top: pad, width: columnWidth, height: maxHeight }
      : { left: pad, top: H - pad - height, width: columnWidth, height };
    // Not enough open space or contrast: put a scrim under the text rather than paying for another picture.
    const strength = parsePosterStyle(layout.style).scrim;
    if (strength !== "transparent" && (strength !== "auto" || spread > BUSY_SPREAD || contrastRatio(text, mean) < 4.5)) {
      const scrim = lightText ? BLACK : WHITE;
      const opacity = strength === "soft" ? 0.35 : strength === "strong" ? 0.8 : 0.58;
      layers.push({ input: panelSvg(W, H, side, Math.round(height + pad * 1.2), Math.round(H * 0.12), scrim, opacity), left: 0, top: 0 });
    }
    const placed = await placeBlocks(fitted.blocks, region, "centre", 0);
    layers.push(...await shadowLayers(placed, lightText ? BLACK : WHITE, Math.max(2, unit * 0.06)), ...placed);
  }
  return { layers, overflow };
}

/** Render `layout` onto `background`. The picture keeps the background's own size. */
export async function renderPoster(background: Buffer, layout: PosterLayout): Promise<RenderedPoster> {
  const base = await sharp(background).rotate().flatten({ background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = base.info;
  if (!W || !H) throw new Error("background size is missing");
  const template = posterTemplateFor(layout.template, W, H);
  if (!posterHasText(layout.fields)) return { body: base.data, mime: "image/png", width: W, height: H, template, overflow: false };
  const { layers, overflow } = template === "overlay"
    ? await overlayPoster(base.data, layout, W, H)
    : await panelPoster(base.data, layout, template, W, H);
  const body = await sharp(base.data).composite(await insideCanvas(layers, W, H)).png().toBuffer();
  return { body, mime: "image/png", width: W, height: H, template, overflow };
}

/** Identifies a rendered poster: the same background and layout always give the same picture, so it is stored once. */
export function posterRenderKey(backgroundKey: string, layout: PosterLayout): string {
  const style = parsePosterStyle(layout.style);
  const values: unknown[] = [backgroundKey, layout.template, layout.fields, layout.titleLines ?? null];
  // Keep the v1 key for its exact defaults; non-default styles have a versioned namespace.
  if (JSON.stringify(style) !== JSON.stringify(DEFAULT_POSTER_STYLE)) values.push({ version: 2, style });
  const content = JSON.stringify(values);
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}
