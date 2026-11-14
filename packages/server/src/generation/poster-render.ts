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
import { parseAccentRuns, parsePosterStyle, POSTER_FONT_SCALE, POSTER_LINE_SPACING, POSTER_PARTS, posterHasText, posterPartVertical,
  posterTemplateFor, titleLineOptions, type PosterExportRatio, type PosterFont, type PosterLayerPlacement, type PosterLayout,
  type PosterPart, type PosterPartStyle, type PosterPreviewScene, type PosterStyle, type PosterTemplate } from "@lot-agent/core/poster";

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
  if (fonts && process.platform === "darwin" && !process.env.PANGOCAIRO_BACKEND) process.env.PANGOCAIRO_BACKEND = "fc";
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

/** Convert `#rrggbb` to an RGB tuple. */
function hexToRgb(color: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as Rgb;
}

/** Apply the user's accent colour override when set, keeping contrast on the discount badge readable. */
function effectivePalette(palette: Palette, style: PosterStyle): Palette {
  if (!style.accentColor) return palette;
  const accent = hexToRgb(style.accentColor);
  return { ...palette, accent, onAccent: contrastRatio(WHITE, accent) >= 3 ? WHITE : [20, 20, 20] };
}

/** The user's own color for a text block, if they picked one. */
function partColor(layout: PosterLayout, part: PosterPart): Rgb | undefined {
  const color = parsePosterStyle(layout.style).parts?.[part]?.color;
  return color ? hexToRgb(color) : undefined;
}

/** A block's nudge in pixels on a W×H canvas. */
function partShift(layout: PosterLayout, part: PosterPart, W: number, H: number): { x: number; y: number } {
  const style = parsePosterStyle(layout.style).parts?.[part];
  return { x: Math.round((style?.dx ?? 0) * W / 100), y: Math.round((style?.dy ?? 0) * H / 100) };
}

function lineSpacingPx(size: number, baseRatio: number, lineSpacingPct?: number): number {
  if (!lineSpacingPct || lineSpacingPct === POSTER_LINE_SPACING.default) return Math.round(size * baseRatio);
  return Math.round(size * (baseRatio + ((lineSpacingPct - POSTER_LINE_SPACING.default) / 100) * 0.6));
}

function posterSpan(layout: PosterLayout, accentColor?: Rgb, fontOverride?: PosterFont) {
  const family = (fontOverride ?? parsePosterStyle(layout.style).font) === "serif" ? "Noto Serif SC" : POSTER_FONT_FAMILY;
  return (
    text: string,
    size: number,
    color: Rgb,
    bold = false,
    extra = "",
    options?: { letterSpacing?: number; runs?: boolean },
  ): string => {
    const px = Math.max(8, Math.round(size));
    const font = `${family}${bold ? " Bold" : ""} ${px}`;
    const tracking = options?.letterSpacing ? ` letter_spacing="${Math.round(px * (options.letterSpacing / 100) * 1024)}"` : "";
    const makeSpan = (segment: string, fill: Rgb) =>
      `<span font_desc="${font}" foreground="${hex(fill)}"${extra}${tracking}>${escapeMarkup(segment)}</span>`;
    if (!options?.runs || !accentColor) return makeSpan(text, color);
    return text.split("\n")
      .map((lineText) => parseAccentRuns(lineText).map((run) => makeSpan(run.text, run.accent ? accentColor : color)).join(""))
      .join("\n");
  };
}

/** Add an anti-aliased text outline behind a rendered text picture when configured on a part. */
async function applyPartStroke(
  picture: Picture, partStyle: PosterPartStyle | undefined, textColor: Rgb, fontSize: number,
): Promise<Picture> {
  if (!partStyle?.stroke || partStyle.stroke === "none") return picture;
  const thickness = Math.max(2, Math.round(fontSize * (partStyle.stroke === "medium" ? 0.08 : 0.045)));
  const pad = thickness + 2;
  const strokeRgb = partStyle.strokeColor ? hexToRgb(partStyle.strokeColor) : (luminance(textColor) < 0.4 ? WHITE : [24, 24, 24] as Rgb);
  const mask = await sharp(picture.data).extractChannel("alpha").png().toBuffer();
  const dilated = await sharp(mask)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0 } })
    .blur(Math.max(0.8, thickness * 0.6))
    .linear(6, -30)
    .toColourspace("b-w")
    .png()
    .toBuffer({ resolveWithObject: true });
  const fill = { r: strokeRgb[0], g: strokeRgb[1], b: strokeRgb[2] };
  const outline = await sharp({ create: { width: dilated.info.width, height: dilated.info.height, channels: 3, background: fill } })
    .joinChannel(dilated.data).png().toBuffer();
  const data = await sharp(outline).composite([{ input: picture.data, left: pad, top: pad }]).png().toBuffer();
  return { data, width: dilated.info.width, height: dilated.info.height };
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

/** `vertical` blocks are columns: consecutive ones stand side by side, right to left. */
interface Block {
  picture: Picture;
  gapBefore: number;
  part: PosterPart;
  vertical: boolean;
  /** Re-typeset at a multiple of the fitted size, with proportionate line breaking constraints. */
  render: (factor: number) => Promise<Picture | null>;
}

async function transparent(width: number, height: number, layers: Layer[]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
}

/** Several pictures side by side on one row, bottoms (or tops) aligned. */
async function rowPicture(items: Picture[], gap: number, align: "bottom" | "top" = "bottom"): Promise<Picture> {
  if (items.length === 1) return items[0];
  const width = items.reduce((sum, item) => sum + item.width, 0) + gap * (items.length - 1);
  const height = Math.max(...items.map((item) => item.height));
  let left = 0;
  const layers = items.map((item) => {
    const layer = { input: item.data, left, top: align === "top" ? 0 : height - item.height };
    left += item.width + gap;
    return layer;
  });
  return { data: await transparent(width, height, layers), width, height };
}

/** Several pictures one below the other, centered. */
async function stackPicture(items: Picture[], gap: number): Promise<Picture> {
  if (items.length === 1) return items[0];
  const width = Math.max(...items.map((item) => item.width));
  const height = items.reduce((sum, item) => sum + item.height, 0) + gap * (items.length - 1);
  let top = 0;
  const layers = items.map((item) => {
    const layer = { input: item.data, left: Math.round((width - item.width) / 2), top };
    top += item.height + gap;
    return layer;
  });
  return { data: await transparent(width, height, layers), width, height };
}

/** Punctuation as its vertical presentation form, so it sits right in a column. */
const VERTICAL_FORMS: Record<string, string> = {
  "，": "︐", ",": "︐", "、": "︑", "。": "︒", "：": "︓", ":": "︓", "；": "︔", ";": "︔", "！": "︕", "!": "︕", "？": "︖", "?": "︖",
  "（": "︵", "(": "︵", "）": "︶", ")": "︶", "「": "﹁", "」": "﹂", "『": "﹃", "』": "﹄", "《": "︽", "》": "︾", "【": "︻", "】": "︼",
  "—": "︱", "－": "︱", "–": "︲", "-": "︲", "~": "︴", "～": "︴", "…": "︙",
};

/** Distance from one character to the next in a column, in font sizes. */
const COLUMN_PITCH = 1.04;

interface VerticalToken {
  kind: "cell" | "tcy" | "rotated" | "space";
  text: string;
  accent: boolean;
}

/** Break text into vertical-column tokens: rotated Latin words & 5+ digit numbers, upright 3–4 digit tate-chu-yoko, and single CJK cells. */
function columnTokens(text: string): VerticalToken[] {
  const tokens: VerticalToken[] = [];
  const normalized = text.trim().replace(/\s+/g, " ");
  for (const run of parseAccentRuns(normalized)) {
    const parts = run.text.match(/[A-Za-z][A-Za-z0-9.&'+\-/]*|\d+|./gu) ?? [];
    for (const part of parts) {
      if (/^\s+$/.test(part)) tokens.push({ kind: "space", text: "", accent: run.accent });
      else if (/^\d{1,2}$/.test(part)) tokens.push({ kind: "cell", text: part, accent: run.accent });
      else if (/^\d{3,4}$/.test(part)) tokens.push({ kind: "tcy", text: part, accent: run.accent });
      else if (/^\d{5,}$/.test(part) || /^[A-Za-z]/.test(part)) tokens.push({ kind: "rotated", text: part, accent: run.accent });
      else tokens.push({ kind: "cell", text: VERTICAL_FORMS[part] ?? part, accent: run.accent });
    }
  }
  return tokens;
}

/** `text` as columns of at most `max` slots, without blank slots at either end of a column. */
function columnChunks(text: string, max: number): VerticalToken[][] {
  const tokens = columnTokens(text);
  const columns: VerticalToken[][] = [];
  for (let start = 0; start < tokens.length; start += max) {
    const column = tokens.slice(start, start + max);
    while (column[0]?.kind === "space") column.shift();
    while (column.at(-1)?.kind === "space") column.pop();
    if (column.length) columns.push(column);
  }
  return columns;
}

/** Render a single vertical column, combining pure cell segments cleanly while rotating Latin words / long numbers 90° clockwise. */
async function renderVerticalColumn(
  tokens: VerticalToken[], size: number, color: Rgb, accentColor: Rgb, layout: PosterLayout,
  bold: boolean, partStyle?: PosterPartStyle,
): Promise<Picture | null> {
  if (!tokens.length) return null;
  const span = posterSpan(layout, accentColor, partStyle?.font);
  const letterSpacing = partStyle?.letterSpacing;
  const pitch = Math.max(0.85, COLUMN_PITCH + ((letterSpacing ?? 0) / 100) * 0.45);
  // Pango spaces CJK lines about 1.4 sizes apart; a negative spacing brings stacked cells to `pitch`.
  const stackSpacing = -Math.round(size * (1.41 - pitch));
  const cellGap = Math.max(1, Math.round(size * Math.max(0.04, pitch - 0.98)));
  const pieces: Picture[] = [];
  let batch: VerticalToken[] = [];
  const flushBatch = async () => {
    if (!batch.some((t) => t.kind === "cell")) {
      batch = [];
      return;
    }
    const markup = batch.map((t) => span(t.text, size, t.accent ? accentColor : color, bold)).join("\n");
    pieces.push(await textPicture(markup, { align: "centre", spacing: stackSpacing }));
    batch = [];
  };
  for (const token of tokens) {
    if (token.kind === "cell" || token.kind === "space") {
      batch.push(token);
      continue;
    }
    await flushBatch();
    const fill = token.accent ? accentColor : color;
    if (token.kind === "tcy") {
      const tcySize = size * (token.text.length === 3 ? 0.68 : 0.56);
      pieces.push(await textPicture(span(token.text, tcySize, fill, bold), { align: "centre" }));
    } else {
      const horiz = await textPicture(span(token.text, size * 0.86, fill, bold, "", { letterSpacing }), { align: "left" });
      const { data, info } = await sharp(horiz.data).rotate(90).png().toBuffer({ resolveWithObject: true });
      pieces.push({ data, width: info.width, height: info.height });
    }
  }
  await flushBatch();
  return pieces.length ? stackPicture(pieces, cellGap) : null;
}

/** Columns written top to bottom, the first on the right, tops aligned. */
async function columnsPicture(
  columns: VerticalToken[][], size: number, color: Rgb, accentColor: Rgb, layout: PosterLayout,
  bold = false, partStyle?: PosterPartStyle,
): Promise<Picture | null> {
  if (!columns.length) return null;
  const pictures: Picture[] = [];
  for (const tokens of columns) {
    const pic = await renderVerticalColumn(tokens, size, color, accentColor, layout, bold, partStyle);
    if (pic) pictures.push(pic);
  }
  const colGap = lineSpacingPx(size, 0.35, partStyle?.lineSpacing);
  return rowPicture(pictures.reverse(), colGap, "top");
}

/** Text on a rounded block of the accent color (the discount badge). */
async function badgePicture(
  text: string, size: number, palette: Palette, layout: PosterLayout, letterSpacing?: number, fontOverride?: PosterFont,
): Promise<Picture> {
  const span = posterSpan(layout, undefined, fontOverride);
  const label = await textPicture(span(text, size, palette.onAccent, true, "", { letterSpacing }));
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
async function priceRow(
  layout: PosterLayout, unit: number, width: number, palette: Palette, color: Rgb, vertical: boolean, factor: number,
): Promise<Picture | null> {
  const { fields } = layout;
  const priceStyle = parsePosterStyle(layout.style).parts?.price;
  const span = posterSpan(layout, undefined, priceStyle?.font);
  const tracking = priceStyle?.letterSpacing;
  if (!fields.price && !fields.originalPrice && !fields.discount) return null;
  const cjk = CJK.test(`${fields.title}${fields.subtitle}${fields.points.join("")}${fields.address}`);
  const sizedUnit = unit * factor;
  const build = async (scale: number) => {
    const items: Picture[] = [];
    const big = sizedUnit * 0.92 * scale;
    if (fields.price) {
      const { before, number, after } = pricePieces(fields.price, cjk);
      const small = big * 0.5;
      items.push(await textPicture(
        (before ? span(before, small, color, true, "", { letterSpacing: tracking }) : "")
        + span(number, big, color, true, "", { letterSpacing: tracking })
        + (after ? span(` ${after}`, small, color, true, "", { letterSpacing: tracking }) : "")
      ));
    }
    if (fields.originalPrice) {
      const { before, number, after } = pricePieces(fields.originalPrice, cjk);
      const text = `${before}${number}${after ? ` ${after}` : ""}`;
      items.push(await textPicture(
        span(text, sizedUnit * 0.36 * scale, palette.muted, false, ' strikethrough="true"', { letterSpacing: tracking })
      ));
    }
    if (fields.discount) {
      items.push(await badgePicture(fields.discount, sizedUnit * (fields.price ? 0.34 : 0.5) * scale, palette, layout, tracking, priceStyle?.font));
    }
    return vertical ? stackPicture(items, Math.round(sizedUnit * 0.12 * scale)) : rowPicture(items, Math.round(sizedUnit * 0.22 * scale));
  };
  const row = await build(1);
  return row.width <= width * factor ? row : build(width * factor / row.width * 0.98);
}

/** The title at the largest size (up to `max`) at which its widest line fits `width`, over the allowed line breaks. */
async function titlePicture(
  layout: PosterLayout, max: number, width: number, color: Rgb, accentColor: Rgb, align: Align, factor: number,
): Promise<Picture | null> {
  const style = parsePosterStyle(layout.style);
  const titleStyle = style.parts?.title;
  const span = posterSpan(layout, accentColor, titleStyle?.font);
  const bold = style.titleWeight === "bold";
  const title = layout.fields.title;
  if (!title) return null;
  let best: { lines: string[]; size: number } | undefined;
  const spanOpts = { letterSpacing: titleStyle?.letterSpacing, runs: true };
  for (const lines of titleLineOptions(title, layout.titleLines, layout.manualTitleLines)) {
    const probe = await textPicture(span(lines.join("\n"), 100, color, bold, "", spanOpts));
    const size = Math.min(max, Math.floor(100 * width / probe.width));
    // More lines must buy clearly larger type to be worth the height.
    const score = size * 0.92 ** (lines.length - 1);
    if (!best || score > best.size * 0.92 ** (best.lines.length - 1)) best = { lines, size };
  }
  if (!best) return null;
  const size = best.size * factor;
  return textPicture(span(best.lines.join("\n"), size, color, bold, "", spanOpts), {
    align, spacing: lineSpacingPx(size, 0.12, titleStyle?.lineSpacing),
  });
}

/** A vertical title runs in one column, even when the planner suggested breaks for the horizontal title. */
async function titleColumn(
  layout: PosterLayout, max: number, width: number, height: number, color: Rgb, accentColor: Rgb, factor: number,
): Promise<Picture | null> {
  const tokens = columnTokens(layout.fields.title);
  if (!tokens.length) return null;
  const style = parsePosterStyle(layout.style);
  const titleStyle = style.parts?.title;
  const pitch = Math.max(0.85, COLUMN_PITCH + ((titleStyle?.letterSpacing ?? 0) / 100) * 0.45);
  const size = Math.floor(Math.min(max, width, height / (tokens.length * pitch))) * factor;
  const picture = await columnsPicture([tokens], size, color, accentColor, layout, style.titleWeight === "bold", titleStyle);
  const limitWidth = Math.max(1, Math.floor(width * factor));
  const limitHeight = Math.max(1, Math.floor(height * factor));
  if (!picture || (picture.width <= limitWidth && picture.height <= limitHeight)) return picture;
  // Font metrics vary, and Pango uses an 8 px minimum. Fit the raster to keep even long titles in one column.
  const { data, info } = await sharp(picture.data).resize(limitWidth, limitHeight, { fit: "inside" })
    .png().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

interface Frame { template: PosterTemplate; width: number; height: number; unit: number; palette: Palette; align: Align }

/**
 * Every text block of a poster, top to bottom, for an area `width` × `height`, with type scaled by `scale`. A part
 * written in columns breaks into as many columns as `height` needs.
 */
async function buildBlocks(layout: PosterLayout, frame: Frame, scale: number): Promise<Block[]> {
  const { width, height, palette, align } = frame;
  const span = posterSpan(layout, palette.accent);
  const style = parsePosterStyle(layout.style);
  const fields = layout.fields;
  const u = frame.unit * scale;
  const blocks: Block[] = [];
  const vertical = (part: PosterPart) => posterPartVertical(style, part, frame.template);
  const color = (part: PosterPart, fallback: Rgb) => partColor(layout, part) ?? fallback;
  const add = async (part: PosterPart, gap: number, strokeColor: Rgb, baseSize: number, rawRender: Block["render"]) => {
    const partStyle = style.parts?.[part];
    const render: Block["render"] = async (factor) => {
      const pic = await rawRender(factor);
      return pic ? applyPartStroke(pic, partStyle, strokeColor, baseSize * factor) : null;
    };
    const picture = await render(1);
    if (picture) blocks.push({ picture, gapBefore: blocks.length ? Math.round(u * gap) : 0, part, vertical: vertical(part), render });
  };
  const columns = (texts: string[], size: number, fill: Rgb, factor: number, partStyle?: PosterPartStyle) => {
    const max = Math.max(1, Math.floor(height / (size * COLUMN_PITCH)));
    return columnsPicture(texts.flatMap((text) => columnChunks(text, max)), size * factor, fill, palette.accent, layout, false, partStyle);
  };
  const titleColor = color("title", palette.text);
  await add("title", 0, titleColor, u, (factor) => vertical("title")
    ? titleColumn(layout, u, width, height * scale, titleColor, palette.accent, factor)
    : titlePicture(layout, u, width, titleColor, palette.accent, align, factor));
  if (fields.subtitle) {
    const fill = color("subtitle", palette.text);
    const subStyle = style.parts?.subtitle;
    const subSpan = posterSpan(layout, palette.accent, subStyle?.font);
    await add("subtitle", 0.2, fill, u * 0.4, (factor) => {
      const size = u * 0.4 * factor;
      return vertical("subtitle") ? columns([fields.subtitle], u * 0.4, fill, factor, subStyle)
        : textPicture(subSpan(fields.subtitle, size, fill, false, "", { letterSpacing: subStyle?.letterSpacing, runs: true }), {
          width: width * factor, align, spacing: lineSpacingPx(size, 0.2, subStyle?.lineSpacing),
        });
    });
  }
  if (fields.points.length) {
    const text = color("points", palette.text);
    const ptsStyle = style.parts?.points;
    const ptsSpan = posterSpan(layout, palette.accent, ptsStyle?.font);
    await add("points", 0.3, text, u * 0.34, (factor) => {
      if (vertical("points")) return columns(fields.points, u * 0.34, text, factor, ptsStyle);
      const size = u * 0.34 * factor;
      const opts = { letterSpacing: ptsStyle?.letterSpacing, runs: true };
      // Centered posters run the points on one flowing line; a left-aligned column lists them.
      const markup = align === "centre"
        ? fields.points.map((point) => ptsSpan(point, size, text, false, "", opts))
          .join(ptsSpan("  ·  ", size, palette.accent, true, "", { letterSpacing: ptsStyle?.letterSpacing }))
        : fields.points.map((point) => ptsSpan("• ", size, palette.accent, true) + ptsSpan(point, size, text, false, "", opts)).join("\n");
      return textPicture(markup, { width: width * factor, align, spacing: lineSpacingPx(size, 0.4, ptsStyle?.lineSpacing) });
    });
  }
  const priceFill = color("price", palette.accent);
  await add("price", 0.3, priceFill, u * 0.92, (factor) => priceRow(layout, u, width, palette, priceFill, vertical("price"), factor));
  let footerGap = 0.34;
  for (const part of ["date", "address"] as const) {
    const value = fields[part];
    if (!value) continue;
    const fill = color(part, palette.muted);
    const partStyle = style.parts?.[part];
    const partSpan = posterSpan(layout, palette.accent, partStyle?.font);
    const gap = footerGap;
    footerGap = 0.14;
    await add(part, gap, fill, u * 0.27, (factor) => {
      const size = u * 0.27 * factor;
      return vertical(part) ? columns([value], u * 0.27, fill, factor, partStyle)
        : textPicture(partSpan(value, size, fill, false, "", { letterSpacing: partStyle?.letterSpacing, runs: true }), {
          width: width * factor, align, spacing: lineSpacingPx(size, 0.35, partStyle?.lineSpacing),
        });
    });
  }
  void span;
  return blocks;
}

/** One line of the stack: a single block, or columns side by side as far as `width` allows. */
interface Row { blocks: Block[]; width: number; height: number; gapBefore: number; gap: number; columns: boolean }

function stackRows(blocks: Block[], width: number, gap: number): Row[] {
  const rows: Row[] = [];
  for (const block of blocks) {
    const last = rows.at(-1);
    const { width: w, height: h } = block.picture;
    if (block.vertical && last?.columns && last.width + gap + w <= width) {
      last.blocks.push(block);
      last.width += gap + w;
      last.height = Math.max(last.height, h);
    } else {
      rows.push({ blocks: [block], width: w, height: h, gapBefore: block.gapBefore, gap, columns: block.vertical });
    }
  }
  return rows;
}

const MIN_SCALE = 0.42;

/** The rows at the largest scale that fit `frame`; `overflow` when even the smallest does not. */
async function fitBlocks(layout: PosterLayout, frame: Frame) {
  let scale = 1;
  for (;;) {
    const blocks = await buildBlocks(layout, frame, scale);
    const rows = stackRows(blocks, frame.width, Math.round(frame.unit * scale * 0.45));
    const height = rows.reduce((sum, row) => sum + row.gapBefore + row.height, 0);
    const width = Math.max(0, ...rows.filter((row) => row.columns).map((row) => row.width));
    const over = Math.max(height / frame.height, width / frame.width);
    if (over <= 1 || scale <= MIN_SCALE) return { rows, height, overflow: over > 1 };
    // Jump most of the way from the measured size, then step down until it fits.
    scale = Math.max(MIN_SCALE, Math.min(scale * 0.92, scale / Math.sqrt(over)));
  }
}

type Layer = { input: Buffer; left: number; top: number };
type PosterLayer = PosterLayerPlacement & { input: Buffer };
type TextLayer = Extract<PosterLayer, { kind: "text" }>;
type ShadowLayer = Extract<PosterLayer, { kind: "shadow" }>;

/** Keep the fitted positions, then apply each part's size change without reflowing the other parts. */
async function placeBlocks(rows: Row[], region: Rect, align: Align, offsetTop: number, parts: PosterStyle["parts"], canvas: Pick<Rect, "width" | "height">) {
  const layers: TextLayer[] = [];
  const place = async (block: Block, left: number, top: number, maxWidth: number, room: number) => {
    const { picture } = block;
    const width = Math.min(picture.width, maxWidth);
    const height = Math.min(picture.height, room);
    const fontScale = parts?.[block.part]?.fontScale;
    if (fontScale !== undefined) {
      // Use the whole canvas for a resized part, even when its base template uses a small text region.
      const factor = Math.min(fontScale / POSTER_FONT_SCALE.default, canvas.width / picture.width, canvas.height / picture.height);
      const resized = await block.render(factor);
      if (resized) {
        const x = left + Math.round((width - resized.width) / 2);
        const y = Math.round(top + (height - resized.height) / 2);
        layers.push({
          kind: "text", part: block.part, input: resized.data, width: resized.width, height: resized.height,
          left: Math.max(0, Math.min(canvas.width - resized.width, x)), top: Math.max(0, Math.min(canvas.height - resized.height, y)),
        });
        return;
      }
    }
    const input = width < picture.width || height < picture.height
      ? await sharp(picture.data).extract({ left: 0, top: 0, width, height }).png().toBuffer()
      : picture.data;
    layers.push({ kind: "text", part: block.part, input, left, top: Math.round(top), width, height });
  };
  let top = region.top + offsetTop;
  for (const row of rows) {
    top += row.gapBefore;
    const room = region.top + region.height - top;
    if (room <= 0) break;
    if (row.columns) {
      // Columns are read right to left and stay centered as a group, whatever the alignment of the other blocks.
      let right = region.left + Math.round((region.width + row.width) / 2);
      for (const block of row.blocks) {
        await place(block, right - block.picture.width, top, block.picture.width, room);
        right -= block.picture.width + row.gap;
      }
    } else {
      const [block] = row.blocks;
      const width = Math.min(block.picture.width, region.width);
      await place(block, align === "centre" ? region.left + Math.round((region.width - width) / 2) : region.left, top, width, room);
    }
    top += row.height;
  }
  return layers;
}

type Side = "top" | "bottom" | "left" | "right";

/** A block of color along one side of the canvas, fading into the picture over `feather` pixels. */
function panelLayer(width: number, height: number, side: Side, size: number, feather: number, color: Rgb, opacity: number): PosterLayer {
  const fill = hex(color);
  // The gradient runs from the canvas edge (solid) to the inner edge of the feather (clear).
  const total = size + feather;
  const solid = (size / total).toFixed(4);
  const [x1, y1, x2, y2] = side === "top" ? [0, 0, 0, 1] : side === "bottom" ? [0, 1, 0, 0] : side === "left" ? [0, 0, 1, 0] : [1, 0, 0, 0];
  const rect = side === "top" ? `x="0" y="0" width="${width}" height="${total}"`
    : side === "bottom" ? `x="0" y="${height - total}" width="${width}" height="${total}"`
    : side === "left" ? `x="0" y="0" width="${total}" height="${height}"`
    : `x="${width - total}" y="0" width="${total}" height="${height}"`;
  const input = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>`
    + `<linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
    + `<stop offset="0" stop-color="${fill}" stop-opacity="${opacity}"/><stop offset="${solid}" stop-color="${fill}" stop-opacity="${opacity}"/>`
    + `<stop offset="1" stop-color="${fill}" stop-opacity="0"/></linearGradient></defs><rect ${rect} fill="url(#g)"/></svg>`
  );
  return { kind: "scrim", input, left: 0, top: 0, width, height };
}

/** A soft shadow of the text layers, so text written on a picture keeps an edge on any background. */
async function shadowLayers(layers: TextLayer[], shade: (layer: TextLayer) => Rgb, blur: number): Promise<ShadowLayer[]> {
  return Promise.all(layers.map(async (layer) => {
    const color = shade(layer);
    const pad = Math.ceil(blur * 3);
    // Two steps: sharp extracts a channel at the end of a pipeline, after extend and blur would have run on all four.
    const mask = await sharp(layer.input).extractChannel("alpha").png().toBuffer();
    const alpha = await sharp(mask).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0 } })
      .blur(blur).linear(0.6, 0).toColourspace("b-w").png().toBuffer({ resolveWithObject: true });
    const fill = { r: color[0], g: color[1], b: color[2] };
    const input = await sharp({ create: { width: alpha.info.width, height: alpha.info.height, channels: 3, background: fill } })
      .joinChannel(alpha.data).png().toBuffer();
    return {
      kind: "shadow", part: layer.part, input, left: layer.left - pad, top: layer.top - pad + Math.round(blur * 0.5),
      width: alpha.info.width, height: alpha.info.height,
    };
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
  const side: Side = template === "top_panel" ? "top" : template === "bottom_panel" ? "bottom" : template === "right_panel" ? "right" : "left";
  const across = side === "top" || side === "bottom";
  const feather = Math.round((across ? H : W) * 0.07);
  const maxSize = Math.round(across ? H * PANEL_MAX_SHARE : W * SIDE_PANEL_SHARE);
  const columnWidth = (across ? W : maxSize) - pad * 2;
  // Columns are bounded by the panel's height, not its narrow width, so a side panel with columns sets larger type.
  const style = parsePosterStyle(layout.style);
  const columns = POSTER_PARTS.some((part) => posterPartVertical(style, part, template));
  const unit = Math.min(!across && columns ? Infinity : columnWidth * 0.13, Math.min(W, H) * 0.1);
  // Color comes from the picture where the panel sits, so the panel continues the picture instead of sitting on it.
  const under: Rect = side === "top" ? { left: 0, top: 0, width: W, height: maxSize }
    : side === "bottom" ? { left: 0, top: H - maxSize, width: W, height: maxSize }
    : side === "left" ? { left: 0, top: 0, width: maxSize, height: H }
    : { left: W - maxSize, top: 0, width: maxSize, height: H };
  const palette = effectivePalette(posterPalette((await areaStats(background, clampRect(under, W, H))).mean), style);
  const align: Align = across ? "centre" : "left";
  const maxHeight = (across ? maxSize : H) - pad * 2;
  const fitted = await fitBlocks(layout, { template, width: columnWidth, height: maxHeight, unit, palette, align });
  // A top / bottom panel is only as tall as its text needs; a side panel runs the full height with the text centered.
  const size = across ? Math.min(maxSize, Math.max(Math.round(H * 0.16), fitted.height + pad * 2)) : maxSize;
  const region: Rect = side === "top" ? { left: pad, top: pad, width: columnWidth, height: size - pad * 2 }
    : side === "bottom" ? { left: pad, top: H - size + pad, width: columnWidth, height: size - pad * 2 }
    : { left: side === "left" ? pad : W - maxSize + pad, top: pad, width: columnWidth, height: H - pad * 2 };
  const offset = Math.max(0, Math.round((region.height - fitted.height) / 2));
  const layers = await placeBlocks(fitted.rows, region, align, offset, style.parts, { width: W, height: H });
  const { scrim } = style;
  // Keep the picture visible through the upper/lower text treatment. `soft` is
  // intentionally lighter still, while `strong` preserves the opaque option.
  const opacity = scrim === "strong" ? 1 : scrim === "soft" ? 0.58 : 0.72;
  const panel = scrim === "transparent" ? [] : [panelLayer(W, H, side, size, feather, palette.panel, opacity)];
  return { layers: [...panel, ...layers], overflow: fitted.overflow };
}

/** Area variation above which text written on the picture gets a scrim (0–255 standard deviation). */
const BUSY_SPREAD = 34;

/**
 * Find the horizontal band of `bandHeight` inside `searchArea` with the lowest combined edge density and brightness
 * variance. A small tie-breaker prefers the outer edge (`anchor`), so uniform scenes keep their classic margin while
 * textured photos shift onto clearer background space.
 */
async function findQuietBand(
  background: Buffer, W: number, H: number, searchArea: Rect, bandHeight: number, anchor: "top" | "bottom",
): Promise<Rect> {
  const area = clampRect(searchArea, W, H);
  if (bandHeight >= area.height || area.height <= 4) return { left: area.left, top: area.top, width: area.width, height: area.height };
  const sampleW = 96;
  const sampleH = Math.max(8, Math.round(sampleW * area.height / Math.max(1, area.width)));
  const { data, info } = await sharp(background)
    .extract(area)
    .resize(sampleW, sampleH, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cols = info.width;
  const rows = info.height;
  const rowEdge = new Float64Array(rows);
  const rowMean = new Float64Array(rows);
  const rowSq = new Float64Array(rows);
  for (let y = 0; y < rows; y++) {
    let edge = 0;
    let sum = 0;
    let sq = 0;
    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x;
      const val = data[idx]!;
      sum += val;
      sq += val * val;
      if (x + 1 < cols) edge += Math.abs(val - data[idx + 1]!);
      if (y + 1 < rows) edge += Math.abs(val - data[idx + cols]!);
    }
    rowEdge[y] = edge / Math.max(1, cols * 2);
    rowMean[y] = sum / cols;
    rowSq[y] = sq / cols;
  }
  const winRows = Math.max(1, Math.min(rows, Math.round(rows * bandHeight / area.height)));
  const maxStart = Math.max(0, rows - winRows);
  let bestStart = anchor === "top" ? 0 : maxStart;
  let bestScore = Infinity;
  for (let start = 0; start <= maxStart; start++) {
    let edgeSum = 0;
    let meanSum = 0;
    let sqSum = 0;
    for (let y = start; y < start + winRows; y++) {
      edgeSum += rowEdge[y]!;
      meanSum += rowMean[y]!;
      sqSum += rowSq[y]!;
    }
    const mean = meanSum / winRows;
    const variance = Math.max(0, sqSum / winRows - mean * mean);
    const dist = maxStart > 0 ? (anchor === "top" ? start / maxStart : (maxStart - start) / maxStart) : 0;
    const score = (edgeSum / winRows) * 0.7 + Math.sqrt(variance) * 0.3 + dist * 2.5;
    if (score < bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  const topOffset = Math.round(bestStart * area.height / rows);
  const clampedTop = Math.max(area.top, Math.min(area.top + area.height - bandHeight, area.top + topOffset));
  return { left: area.left, top: clampedTop, width: area.width, height: Math.min(bandHeight, area.height) };
}

/** Check whether reserved poster text strips contain dense text-like stroke clusters on the generated background. */
export async function inspectPosterBackground(background: Buffer, template: PosterTemplate): Promise<{ suspect: boolean }> {
  const { width: W = 0, height: H = 0 } = await sharp(background).rotate().metadata();
  if (!W || !H) return { suspect: false };
  const resolved = posterTemplateFor(template, W, H);
  const strips: Rect[] = resolved === "bottom_panel" ? [{ left: 0, top: Math.round(H * 0.6), width: W, height: Math.round(H * 0.4) }]
    : resolved === "top_panel" ? [{ left: 0, top: 0, width: W, height: Math.round(H * 0.4) }]
    : resolved === "side_panel" ? [{ left: 0, top: 0, width: Math.round(W * 0.44), height: H }]
    : resolved === "right_panel" ? [{ left: Math.round(W * 0.56), top: 0, width: Math.round(W * 0.44), height: H }]
    : [
      { left: 0, top: 0, width: W, height: Math.round(H * 0.34) },
      { left: 0, top: Math.round(H * 0.68), width: W, height: Math.round(H * 0.32) },
    ];
  for (const strip of strips) {
    const area = clampRect(strip, W, H);
    const { data, info } = await sharp(background)
      .rotate()
      .extract(area)
      .resize(192, undefined, { fit: "inside" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cols = info.width;
    const rows = info.height;
    if (cols < 8 || rows < 8) continue;
    let strongGrad = 0;
    let strokeRows = 0;
    for (let y = 0; y < rows; y++) {
      let rowTransitions = 0;
      for (let x = 0; x + 1 < cols; x++) {
        const idx = y * cols + x;
        const dx = Math.abs(data[idx]! - data[idx + 1]!);
        const dy = y + 1 < rows ? Math.abs(data[idx]! - data[idx + cols]!) : 0;
        if (dx >= 34 || dy >= 34) strongGrad++;
        if (dx >= 36) rowTransitions++;
      }
      if (rowTransitions >= 6) strokeRows++;
    }
    const gradShare = strongGrad / Math.max(1, (cols - 1) * rows);
    const strokeRowShare = strokeRows / rows;
    if (gradShare >= 0.09 && strokeRowShare >= 0.16) return { suspect: true };
  }
  return { suspect: false };
}

async function overlayPoster(background: Buffer, layout: PosterLayout, W: number, H: number) {
  const pad = Math.round(Math.min(W, H) * 0.07);
  const columnWidth = W - pad * 2;
  const unit = Math.min(columnWidth * 0.13, Math.min(W, H) * 0.105);
  const style = parsePosterStyle(layout.style);
  const { scrim: strength, parts } = style;
  const { fields } = layout;
  const head: PosterLayout = { ...layout, fields: { ...fields, points: [], price: "", originalPrice: "", discount: "", date: "", address: "" } };
  const foot: PosterLayout = { ...layout, fields: { ...fields, title: "", subtitle: "" }, titleLines: undefined };
  const layers: PosterLayer[] = [];
  let overflow = false;
  const makeOverlayPalette = (mean: Rgb) => {
    const lightText = luminance(mean) < 0.4;
    const text: Rgb = lightText ? WHITE : [24, 24, 24];
    const palette = effectivePalette({
      panel: mean, text, muted: mix(text, mean, 0.18), accent: lightText ? [255, 214, 102] : [196, 44, 8],
      onAccent: lightText ? [24, 24, 24] : WHITE,
    }, style);
    return { lightText, text, palette };
  };
  for (const [part, side, share] of [[head, "top", 0.4], [foot, "bottom", 0.34]] as const) {
    const maxHeight = Math.round(H * share) - pad;
    const searchRect: Rect = side === "top"
      ? { left: pad, top: pad, width: columnWidth, height: maxHeight }
      : { left: pad, top: H - pad - maxHeight, width: columnWidth, height: maxHeight };
    const area = clampRect({ left: 0, top: side === "top" ? 0 : H * (1 - share), width: W, height: H * share }, W, H);
    const initialStats = await areaStats(background, area);
    let { lightText, text, palette } = makeOverlayPalette(initialStats.mean);
    let fitted = await fitBlocks(part, { template: "overlay", width: columnWidth, height: maxHeight, unit, palette, align: "centre" });
    if (!fitted.rows.length) continue;
    const height = Math.min(fitted.height, maxHeight);
    const quiet = await findQuietBand(background, W, H, searchRect, height, side);
    const { mean, spread } = await areaStats(background, clampRect(quiet, W, H));
    if ((luminance(mean) < 0.4) !== lightText) {
      ({ lightText, text, palette } = makeOverlayPalette(mean));
      fitted = await fitBlocks(part, { template: "overlay", width: columnWidth, height: maxHeight, unit, palette, align: "centre" });
    }
    overflow ||= fitted.overflow;
    const region: Rect = { left: pad, top: quiet.top, width: columnWidth, height };
    // Not enough open space or contrast: put a scrim under the text rather than paying for another picture.
    if (strength !== "transparent" && (strength !== "auto" || spread > BUSY_SPREAD || contrastRatio(text, mean) < 4.5)) {
      const scrim = lightText ? BLACK : WHITE;
      const opacity = strength === "soft" ? 0.35 : strength === "strong" ? 0.8 : 0.58;
      const edgeExtent = side === "top" ? quiet.top + height + pad * 0.2 : (H - quiet.top) + pad * 0.2;
      layers.push(panelLayer(W, H, side, Math.round(edgeExtent), Math.round(H * 0.12), scrim, opacity));
    }
    const placed = await placeBlocks(fitted.rows, region, "centre", 0, parts, { width: W, height: H });
    if (strength !== "transparent") {
      const shade = (layer: TextLayer) => {
        const own = partColor(layout, layer.part);
        return (own ? luminance(own) < 0.4 : !lightText) ? WHITE : BLACK;
      };
      layers.push(...await shadowLayers(placed, shade, Math.max(2, unit * 0.06)));
    }
    layers.push(...placed);
  }
  return { layers, overflow };
}

export interface PosterRenderOptions {
  scale?: 1 | 2;
  ratio?: PosterExportRatio;
}

const MAX_RENDER_EDGE = 4096;

function targetDimensions(W: number, H: number, ratio?: PosterExportRatio, scale: 1 | 2 = 1): { width: number; height: number } {
  let targetW = W;
  let targetH = H;
  if (ratio && ratio !== "original") {
    const [rw, rh] = ratio.split(":").map(Number);
    if (rw > 0 && rh > 0) {
      const aspect = rw / rh;
      const area = W * H;
      targetW = Math.max(64, Math.round(Math.sqrt(area * aspect)));
      targetH = Math.max(64, Math.round(targetW / aspect));
    }
  }
  let outW = Math.round(targetW * scale);
  let outH = Math.round(targetH * scale);
  const largest = Math.max(outW, outH);
  if (largest > MAX_RENDER_EDGE) {
    const factor = MAX_RENDER_EDGE / largest;
    outW = Math.round(outW * factor);
    outH = Math.round(outH * factor);
  }
  return { width: outW, height: outH };
}

async function prepareCanvas(background: Buffer, options?: PosterRenderOptions): Promise<{ data: Buffer; width: number; height: number }> {
  const oriented = await sharp(background).rotate().flatten({ background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
  const W = oriented.info.width;
  const H = oriented.info.height;
  if (!W || !H) throw new Error("background size is missing");
  const scale = options?.scale === 2 ? 2 : 1;
  const { width: outW, height: outH } = targetDimensions(W, H, options?.ratio, scale);
  if (outW === W && outH === H) return { data: oriented.data, width: W, height: H };
  const sameAspect = Math.abs(W / H - outW / outH) < 0.015;
  if (sameAspect) {
    const resized = await sharp(oriented.data).resize(outW, outH, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
    return { data: resized, width: outW, height: outH };
  }
  // Aspect changed: build a soft blurred backdrop of the image itself and center the sharp original inside it.
  const backdrop = await sharp(oriented.data)
    .resize(outW, outH, { fit: "cover" })
    .blur(Math.max(12, Math.round(Math.min(outW, outH) * 0.03)))
    .modulate({ brightness: 0.92 })
    .png()
    .toBuffer();
  const fg = await sharp(oriented.data)
    .resize(outW, outH, { fit: "inside", kernel: "lanczos3" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((outW - fg.info.width) / 2);
  const top = Math.round((outH - fg.info.height) / 2);
  const merged = await sharp(backdrop).composite([{ input: fg.data, left, top }]).png().toBuffer();
  return { data: merged, width: outW, height: outH };
}

async function buildPoster(background: Buffer, layout: PosterLayout, options?: PosterRenderOptions) {
  const canvas = await prepareCanvas(background, options);
  const { width: W, height: H, data } = canvas;
  const template = posterTemplateFor(layout.template, W, H);
  const { layers, overflow } = !posterHasText(layout.fields) ? { layers: [], overflow: false } : template === "overlay"
    ? await overlayPoster(data, layout, W, H) : await panelPoster(data, layout, template, W, H);
  return { base: data, layers, width: W, height: H, template, overflow };
}

/** Render `layout` onto `background`. Supports optional `scale` (1 or 2) and aspect `ratio` re-typesetting. */
export async function renderPoster(background: Buffer, layout: PosterLayout, options?: PosterRenderOptions): Promise<RenderedPoster> {
  const { base, layers, width, height, template, overflow } = await buildPoster(background, layout, options);
  const partsStyle = parsePosterStyle(layout.style).parts;
  const placed = await Promise.all(layers.map(async (layer) => {
    const { input, left, top } = layer;
    const shift = layer.kind === "scrim" ? { x: 0, y: 0 } : partShift(layout, layer.part, width, height);
    const angle = layer.kind === "scrim" ? 0 : (partsStyle?.[layer.part]?.rotate ?? 0);
    if (!angle) return { input, left: left + shift.x, top: top + shift.y };
    const rotated = await sharp(input).ensureAlpha()
      .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer({ resolveWithObject: true });
    const cx = left + shift.x + layer.width / 2;
    const cy = top + shift.y + layer.height / 2;
    return {
      input: rotated.data,
      left: Math.round(cx - rotated.info.width / 2),
      top: Math.round(cy - rotated.info.height / 2),
    };
  }));
  const body = placed.length ? await sharp(base).composite(await insideCanvas(placed, width, height)).png().toBuffer() : base;
  return { body, mime: "image/png", width, height, template, overflow };
}

/** The same typesetting as the saved image, with unshifted layers the editor can move locally. */
export async function renderPosterPreview(background: Buffer, layout: PosterLayout): Promise<PosterPreviewScene> {
  const { base, layers, width, height } = await buildPoster(background, layout);
  // Only the preview background needs fewer pixels. Positions still use the full canvas size.
  const photo = await sharp(base).resize(1280, 1280, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const dataUrl = (input: Buffer, mime: string) => `data:${mime};base64,${input.toString("base64")}`;
  return {
    width, height, background: dataUrl(photo, "image/jpeg"),
    layers: layers.map(({ input, ...layer }) => ({ ...layer, src: dataUrl(input, layer.kind === "scrim" ? "image/svg+xml" : "image/png") })),
  };
}

/** Identifies a rendered poster: the same background and layout always give the same picture, so it is stored once. */
export function posterRenderKey(backgroundKey: string, layout: PosterLayout): string {
  // Render revision 6 adds per-part rotation around layer center.
  const values = [
    6, backgroundKey, layout.template, layout.fields, layout.titleLines ?? null,
    layout.manualTitleLines ?? false, parsePosterStyle(layout.style),
  ];
  const content = JSON.stringify(values);
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}
