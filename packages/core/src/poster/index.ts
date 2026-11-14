/**
 * Real-font posters (真实字体). The image model paints a background with no text; the server then typesets the
 * wording on top with real fonts. `PosterLayout` is the only source of a poster's text: it is planned once by a text
 * model, checked here in code, stored on the generation message and rendered again for free whenever the user edits
 * it. Nothing in this module touches fonts or pixels, so the web client shares it.
 */

export const POSTER_VERSION = 2;

export const POSTER_FONTS = ["sans", "serif"] as const;
export const POSTER_TITLE_WEIGHTS = ["regular", "bold"] as const;
export const POSTER_SCRIMS = ["auto", "transparent", "soft", "strong"] as const;
export const POSTER_STROKES = ["none", "thin", "medium"] as const;
export type PosterStroke = typeof POSTER_STROKES[number];
/** Text blocks a user can recolor, style and nudge one by one. */
export const POSTER_PARTS = ["title", "subtitle", "points", "price", "date", "address"] as const;
export type PosterPart = typeof POSTER_PARTS[number];
/** Furthest nudge, in percent of the canvas width (dx) or height (dy). */
export const POSTER_NUDGE_LIMIT = 100;
export const POSTER_FONT_SCALE = { default: 100, min: 50, max: 300, step: 10 } as const;
export const POSTER_LETTER_SPACING = { default: 0, min: -10, max: 50, step: 5 } as const;
export const POSTER_LINE_SPACING = { default: 100, min: 80, max: 200, step: 10 } as const;

export interface PosterPartStyle {
  /** `#rrggbb`; absent means the color picked from the picture. */
  color?: string;
  dx?: number;
  dy?: number;
  /** Percentage of the font size chosen by automatic layout. */
  fontScale?: number;
  /** Written top to bottom in columns; absent means the template's own default (vertical in side panels). */
  vertical?: boolean;
  /** Extra spacing between characters, in percent of font size. */
  letterSpacing?: number;
  /** Line spacing percentage relative to the automatic default (100). */
  lineSpacing?: number;
  /** Text outline thickness. */
  stroke?: PosterStroke;
  /** `#rrggbb`; absent picks high-contrast black or white against the text color. */
  strokeColor?: string;
}

export interface PosterStyle {
  font: typeof POSTER_FONTS[number];
  titleWeight: typeof POSTER_TITLE_WEIGHTS[number];
  scrim: typeof POSTER_SCRIMS[number];
  /** `#rrggbb`; overrides the automatic accent color used for discount badges, highlights and bullets. */
  accentColor?: string;
  parts?: Partial<Record<PosterPart, PosterPartStyle>>;
}
export const DEFAULT_POSTER_STYLE: PosterStyle = { font: "sans", titleWeight: "bold", scrim: "auto" };

function hexColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
}

function clampedOption(value: unknown, limits: { default: number; min: number; max: number }): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.max(limits.min, Math.min(limits.max, Math.round(value)));
  return clamped !== limits.default ? clamped : undefined;
}

function nudge(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-POSTER_NUDGE_LIMIT, Math.min(POSTER_NUDGE_LIMIT, Math.round(value)));
}

function parsePartStyle(raw: unknown): PosterPartStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { color, dx, dy, vertical, fontScale, letterSpacing, lineSpacing, stroke, strokeColor } = raw as Record<string, unknown>;
  const part: PosterPartStyle = {};
  const validColor = hexColor(color);
  if (validColor) part.color = validColor;
  if (nudge(dx)) part.dx = nudge(dx);
  if (nudge(dy)) part.dy = nudge(dy);
  if (typeof vertical === "boolean") part.vertical = vertical;
  const size = clampedOption(fontScale, POSTER_FONT_SCALE);
  if (size !== undefined) part.fontScale = size;
  const tracking = clampedOption(letterSpacing, POSTER_LETTER_SPACING);
  if (tracking !== undefined) part.letterSpacing = tracking;
  const leading = clampedOption(lineSpacing, POSTER_LINE_SPACING);
  if (leading !== undefined) part.lineSpacing = leading;
  if (POSTER_STROKES.includes(stroke as PosterStroke) && stroke !== "none") {
    part.stroke = stroke as PosterStroke;
    const outline = hexColor(strokeColor);
    if (outline) part.strokeColor = outline;
  }
  return Object.keys(part).length ? part : undefined;
}

function partStyles(value: unknown): PosterStyle["parts"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const parts: NonNullable<PosterStyle["parts"]> = {};
  const legacyFooter = parsePartStyle(record.footer);
  for (const name of POSTER_PARTS) {
    const parsed = parsePartStyle(record[name]);
    const merged = (name === "date" || name === "address") && legacyFooter
      ? { ...legacyFooter, ...parsed }
      : parsed;
    if (merged && Object.keys(merged).length) parts[name] = merged;
  }
  return Object.keys(parts).length ? parts : undefined;
}

/** Only known styles reach Pango. Old layouts and unknown values retain the original appearance. */
export function parsePosterStyle(value: unknown): PosterStyle {
  const style = (value && typeof value === "object" ? value : {}) as Partial<PosterStyle>;
  const parts = partStyles(style.parts);
  const accentColor = hexColor(style.accentColor);
  return {
    font: POSTER_FONTS.includes(style.font!) ? style.font! : "sans",
    titleWeight: POSTER_TITLE_WEIGHTS.includes(style.titleWeight!) ? style.titleWeight! : "bold",
    scrim: POSTER_SCRIMS.includes(style.scrim!) ? style.scrim! : "auto",
    ...(accentColor ? { accentColor } : {}),
    ...(parts ? { parts } : {}),
  };
}

/**
 * Where the text goes. The panel templates put it on a block of color taken from the picture, so it is always
 * readable; `overlay` writes straight onto the picture and relies on open space plus a scrim. `side_panel` has the
 * text on the left, `right_panel` on the right.
 */
export const POSTER_TEMPLATES = ["bottom_panel", "top_panel", "side_panel", "right_panel", "overlay"] as const;
export type PosterTemplate = typeof POSTER_TEMPLATES[number];
export const DEFAULT_POSTER_TEMPLATE: PosterTemplate = "overlay";

export function posterSideTemplate(template: PosterTemplate): boolean {
  return template === "side_panel" || template === "right_panel";
}

/** Whether a part is written in columns: the user's own choice, else vertical in the side panels only. */
export function posterPartVertical(style: PosterStyle | undefined, part: PosterPart, template: PosterTemplate): boolean {
  return style?.parts?.[part]?.vertical ?? posterSideTemplate(template);
}

export interface PosterFields {
  title: string;
  subtitle: string;
  points: string[];
  price: string;
  originalPrice: string;
  discount: string;
  date: string;
  address: string;
}
export type PosterFieldName = keyof PosterFields;

/** Longest text kept per field (characters), and how many selling points. */
export const POSTER_LIMITS = {
  title: 40, subtitle: 60, point: 30, points: 4, price: 20, originalPrice: 20, discount: 16, date: 40, address: 60,
} as const;

export interface PosterLayout {
  version: number;
  template: PosterTemplate;
  fields: PosterFields;
  style?: PosterStyle;
  /** Title line breaks suggested by the planner or set manually by the user. */
  titleLines?: string[];
  /** When true, `titleLines` are explicit user breaks and must not be overridden by auto-balancing. */
  manualTitleLines?: boolean;
  /** Fields the planner filled with a number the user never wrote. They were emptied; the card asks the user to fill them. */
  cleared?: PosterFieldName[];
  /** The stored text-free picture this poster is rendered on. */
  background?: { url: string };
  /** The text did not fit even at the smallest size; the card suggests shortening it. */
  overflow?: boolean;
}

/** Preview layers in paint order, positioned in canvas pixels before each part's dx/dy is applied. */
export type PosterLayerPlacement = { left: number; top: number; width: number; height: number } & (
  { kind: "scrim" } | { kind: "shadow"; part: PosterPart } | { kind: "text"; part: PosterPart }
);

export interface PosterPreviewScene {
  width: number;
  height: number;
  background: string;
  layers: (PosterLayerPlacement & { src: string })[];
}

export function parsePosterTemplate(value: unknown): PosterTemplate | null {
  return POSTER_TEMPLATES.includes(value as PosterTemplate) ? value as PosterTemplate : null;
}

export function emptyPosterFields(): PosterFields {
  return { title: "", subtitle: "", points: [], price: "", originalPrice: "", discount: "", date: "", address: "" };
}

/** One line of plain text: control characters and line breaks become spaces, then it is trimmed and cut to `max`. */
function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}

/** Fields from any source (model reply, client edit, stored metadata) as clean single lines within the limits. */
export function sanitizePosterFields(raw: unknown): PosterFields {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const points = Array.isArray(value.points) ? value.points : [];
  return {
    title: line(value.title, POSTER_LIMITS.title),
    subtitle: line(value.subtitle, POSTER_LIMITS.subtitle),
    points: points.map((point) => line(point, POSTER_LIMITS.point)).filter(Boolean).slice(0, POSTER_LIMITS.points),
    price: line(value.price, POSTER_LIMITS.price),
    originalPrice: line(value.originalPrice, POSTER_LIMITS.originalPrice),
    discount: line(value.discount, POSTER_LIMITS.discount),
    date: line(value.date, POSTER_LIMITS.date),
    address: line(value.address, POSTER_LIMITS.address),
  };
}

export function posterHasText(fields: PosterFields): boolean {
  return !!(fields.title || fields.subtitle || fields.points.length || fields.price || fields.originalPrice || fields.discount
    || fields.date || fields.address);
}

/** Full-width digits and punctuation written as their plain forms, without spaces, lower case: for comparing text. */
function comparable(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** Normalize only unambiguous currency grouping, never decimal punctuation indiscriminately. */
function sourceText(text: string): string {
  return comparable(text)
    .replace(/([¥$€£])([0-9]{1,3}(?:,[0-9]{3})+)(?!\d)/g, (_, unit: string, amount: string) => unit + amount.replace(/,/g, ""))
    .replace(/(rp\.?)([0-9]{1,3}(?:\.[0-9]{3})+)(?!\d)/g, (_, unit: string, amount: string) => unit + amount.replace(/\./g, ""));
}

function sourced(value: string, source: string): boolean {
  const needle = sourceText(value);
  const haystack = sourceText(source);
  let start = haystack.indexOf(needle);
  while (start >= 0) {
    const before = haystack.slice(0, start);
    const after = haystack.slice(start + needle.length);
    if (!(/^\d/.test(needle) && /\d[.,]?$/.test(before)) && !(/\d$/.test(needle) && /^[.,]?\d/.test(after))) return true;
    start = haystack.indexOf(needle, start + 1);
  }
  return false;
}

const MONEY_TOKEN = /(?:[¥￥$€£]|rp\.?|usd|idr)\s*\d+(?:[.,]\d+)*(?:\s*(?:元|块))?|\d+(?:[.,]\d+)*\s*(?:元|块|%|％|折)(?:\s*off\b)?/gi;
const ORIGINAL_LABEL = /(?:原价|原售|original\s*price|was|harga\s*normal)\s*[:：]?\s*((?:[¥￥$€£]|rp\.?|usd|idr)?\s*\d+(?:[.,]\d+)*(?:\s*(?:元|块))?)/gi;

/** A number that reads as a price or a rate (¥199, 199 元, 8 折, 20%, Rp 25.000). */
const PRICE_LIKE = /(?:[¥￥$€£]|rp\.?)\s*\d|\d\s*(?:元|块|%|％|折|off\b)/i;

const STRICT_FIELDS = ["price", "originalPrice", "discount", "date"] as const;

/**
 * Check planned text against what the user actually wrote. Prices, rates and dates must not come from the model:
 * the complete value and unit must appear in the request, including dates without digits.
 * Anything else is emptied and reported in `cleared`, and the user fills it on the card. Headline, subtitle
 * and selling points are free text, but a price or rate inside them is held to the same rule.
 */
export function verifyPosterFields(fields: PosterFields, source: string): { fields: PosterFields; cleared: PosterFieldName[] } {
  const next: PosterFields = { ...fields, points: [...fields.points] };
  const cleared: PosterFieldName[] = [];
  for (const name of STRICT_FIELDS) {
    const value = next[name];
    if (!value) continue;
    const originalValues = [...source.matchAll(ORIGINAL_LABEL)].map(match => match[1].split(/现价|售价|sale|now|harga promo/i)[0]);
    let ok = sourced(value, source);
    if (name === "originalPrice") ok = originalValues.some(part => sourced(value, part));
    if (name === "price" && originalValues.some(part => sourced(value, part))) {
      ok = sourced(value, source.replace(ORIGINAL_LABEL, ""));
    }
    // Bare numeric fields require explicit price context, not a quantity elsewhere in the request.
    if ((name === "price" || name === "originalPrice") && /^\d[\d.,]*$/.test(sourceText(value))) {
      const literal = sourceText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      ok &&= new RegExp(`(?:价格|原价|现价|售价|只要|price|was|now|harga)\\s*[:：]?\\s*${literal}(?![\\d.,])`, "i")
        .test(source.normalize("NFKC"));
    }
    if (!ok) {
      next[name] = "";
      cleared.push(name);
    }
  }
  const invented = (text: string) => PRICE_LIKE.test(text.normalize("NFKC"))
    && [...text.normalize("NFKC").matchAll(MONEY_TOKEN)].some(match => !sourced(match[0], source));
  for (const name of ["title", "subtitle"] as const) {
    if (next[name] && invented(next[name])) {
      next[name] = "";
      cleared.push(name);
    }
  }
  const points = next.points.filter((point) => !invented(point));
  if (points.length < next.points.length) cleared.push("points");
  next.points = points;
  return { fields: next, cleared };
}

/** Split text by `【keyword】` accent markers; unmatched brackets stay literal. */
export function parseAccentRuns(text: string): { text: string; accent: boolean }[] {
  if (!text) return [];
  const runs: { text: string; accent: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(/【([^【】]+)】/g)) {
    const start = match.index ?? 0;
    if (start > last) runs.push({ text: text.slice(last, start), accent: false });
    runs.push({ text: match[1], accent: true });
    last = start + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), accent: false });
  return runs.length ? runs : [{ text, accent: false }];
}

/** Join title lines back into a single title string without fusing adjacent Latin words. */
function joinTitleLines(lines: string[]): string {
  return lines.reduce((acc, part) => {
    if (!acc) return part;
    const needsSpace = /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(part);
    return acc + (needsSpace ? " " : "") + part;
  }, "");
}

/** Parse a user's title box value supporting explicit line breaks via newline or `|`. */
export function parseManualTitleInput(raw: unknown): { title: string; titleLines?: string[]; manualTitleLines?: boolean } {
  if (typeof raw !== "string") return { title: "" };
  if (!/[\r\n|]/.test(raw)) return { title: line(raw, POSTER_LIMITS.title) };
  const parts = raw
    .split(/[\r\n|]+/)
    .map((item) => line(item, POSTER_LIMITS.title))
    .filter(Boolean)
    .slice(0, 4);
  if (!parts.length) return { title: "" };
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const count = Array.from(part).length;
    if (kept.length > 0 && length + count > POSTER_LIMITS.title) break;
    kept.push(Array.from(part).slice(0, POSTER_LIMITS.title - length).join("").trim());
    length += Array.from(kept[kept.length - 1]).length;
  }
  const title = line(joinTitleLines(kept), POSTER_LIMITS.title);
  if (kept.length < 2) return { title };
  return { title, titleLines: kept, manualTitleLines: true };
}

/** The line breaks for a title, when joined they match the title itself. */
export function acceptedTitleLines(title: string, suggested: unknown, manual = false): string[] | undefined {
  const maxLines = manual ? 4 : 3;
  const minChars = manual ? 1 : 2;
  if (!Array.isArray(suggested) || suggested.length < 2 || suggested.length > maxLines) return undefined;
  const lines = suggested.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (lines.some((item) => Array.from(item).length < minChars)) return undefined;
  return comparable(lines.join("")) === comparable(title) ? lines : undefined;
}

const BREAK_AFTER = /[，。！？、；：,.!?;:\s]/;

/** Character indices inside `【...】` spans where an auto-break must not cut. */
function protectedBreaks(chars: string[]): boolean[] {
  const blocked = new Array<boolean>(chars.length + 1).fill(false);
  const text = chars.join("");
  for (const match of text.matchAll(/【[^【】]+】/g)) {
    const charStart = Array.from(text.slice(0, match.index ?? 0)).length;
    const charEnd = charStart + Array.from(match[0]).length;
    for (let i = charStart + 1; i < charEnd; i++) blocked[i] = true;
  }
  return blocked;
}

/** Split `text` into `count` lines of similar length, breaking after punctuation or a space when one is near. */
function balancedLines(text: string, count: number): string[] | undefined {
  const chars = Array.from(text);
  if (chars.length < count * 2) return undefined;
  const blocked = protectedBreaks(chars);
  const lines: string[] = [];
  let start = 0;
  for (let part = 1; part < count; part++) {
    const ideal = Math.round(chars.length * part / count);
    const reach = Math.max(1, Math.floor(chars.length / count / 2));
    let cut = ideal;
    let found = false;
    for (let offset = 0; offset <= reach; offset++) {
      const after = [ideal + offset, ideal - offset].find(
        (index) => index - start >= 2 && chars.length - index >= 2 && !blocked[index] && BREAK_AFTER.test(chars[index - 1])
      );
      if (after !== undefined) {
        cut = after;
        found = true;
        break;
      }
    }
    if (!found && blocked[cut]) {
      const open = [1, -1].flatMap((dir) => Array.from({ length: chars.length }, (_, k) => ideal + dir * (k + 1)))
        .find((index) => index - start >= 2 && chars.length - index >= 2 && !blocked[index]);
      if (open === undefined) return undefined;
      cut = open;
    }
    if (cut - start < 2 || chars.length - cut < 2 || blocked[cut]) return undefined;
    lines.push(chars.slice(start, cut).join("").trim());
    start = cut;
  }
  lines.push(chars.slice(start).join("").trim());
  return lines.every((item) => Array.from(item).length >= 2) ? lines : undefined;
}

/**
 * Ways to set a title, best first for a tie: on one line, as the planner suggested, or in two or three balanced
 * lines. When `manual` is true, returns only the user's explicit line breaks.
 */
export function titleLineOptions(title: string, suggested?: unknown, manual = false): string[][] {
  const accepted = acceptedTitleLines(title, suggested, manual);
  if (manual && accepted) return [accepted];
  const options: string[][] = [[title]];
  if (accepted) options.push(accepted);
  for (const count of [2, 3]) {
    const lines = balancedLines(title, count);
    if (lines && !options.some((option) => option.join("\n") === lines.join("\n"))) options.push(lines);
  }
  return options;
}

/**
 * The template actually used on a canvas. Top / bottom panels need height, so a wide canvas gets the left panel;
 * side panels write in columns by default and work at any ratio. Every template therefore works at any ratio.
 */
export function posterTemplateFor(template: PosterTemplate, width: number, height: number): PosterTemplate {
  if ((template === "bottom_panel" || template === "top_panel") && width / height > 1.5) return "side_panel";
  return template;
}

const NO_TEXT = "Absolutely no text, letters, numbers, characters, logos, watermarks, signage or labels anywhere in the image.";

const COMPOSITION: Record<PosterTemplate, string> = {
  bottom_panel: "Composition: keep the main subject in the top 60% of the frame and leave natural space in the bottom 40%.",
  top_panel: "Composition: keep the main subject in the bottom 60% of the frame and leave natural space in the top 40%.",
  side_panel: "Composition: keep the main subject in the right 55% of the frame and leave natural space in the left 45%.",
  right_panel: "Composition: keep the main subject in the left 55% of the frame and leave natural space in the right 45%.",
  overlay: "Composition: keep the main subject in the middle of the frame and leave natural space in the top 35% and bottom 25%.",
};

const NATURAL_COPY_SPACE = "Keep the same surfaces, texture and detail across the reserved areas and the rest of the scene. "
  + "Do not add panels, color bands, haze, blur or gradient overlays to make room for text.";

/** The prompt sent to the image model: the planned picture plus the room the template needs and the no-text rule. */
export function posterBackgroundPrompt(prompt: string, template: PosterTemplate): string {
  return `${prompt.trim()}\n\n${COMPOSITION[template]}\n${NATURAL_COPY_SPACE}\n${NO_TEXT}`;
}

/** System prompt of the poster planner. Model-facing text stays English; the poster text follows the user's language. */
export function posterPlanSystemPrompt(referenceImages: number): string {
  const references = referenceImages > 0
    ? `The user attached ${referenceImages} reference image(s), which you cannot see. Treat them as the user's actual product or subject: `
      + "the background prompt must say to keep it from the reference image exactly as it is (shape, color, proportions and material) "
      + "and to build the scene around it."
    : "No reference image is attached, so describe the subject concretely from the user's text.";
  return [
    "You plan a poster that is made in two layers. An image model paints the picture with no text at all, and the app then typesets",
    "the wording on top with real fonts. From the user's request, write the prompt for the picture and extract the wording.",
    "",
    '"background": an English prompt of at most 900 characters describing only the picture: subject, scene, style, lighting, colors and mood.',
    "Do not ask for any text, letters, numbers, logo or watermark in it and do not say where text goes; the app adds those rules itself.",
    references,
    "Proper names stay in the user's own words: copy every brand name, product or series name, model number, shop name, character name",
    "and place name from the request exactly as written, in its original language and script. Do not translate or romanize them.",
    "",
    '"template": where the wording goes. One of:',
    '- "bottom_panel": picture on top, text panel at the bottom.',
    '- "top_panel": text panel at the top, picture below.',
    '- "side_panel": text panel on the left, picture on the right; the wording is written in vertical columns.',
    '- "right_panel": text panel on the right, picture on the left; the wording is written in vertical columns.',
    '- "overlay": wording written directly over the picture, the default for a clean poster. Use it when the picture has calm copy space; the user can change it later.',
    "",
    "The wording, in the language of the user's request:",
    '- "title": the headline, at most 16 CJK characters or 6 words. Use the user\'s own wording when they give one; otherwise write a short one.',
    '- "titleLines": the title split into 1 to 3 lines at natural phrase boundaries. Joined together the lines must equal the title exactly,',
    "  and no line may be a single character.",
    '- "subtitle": one supporting line of at most 24 characters, or "".',
    '- "points": up to 4 short selling points or highlights taken from the request, each at most 14 characters; [] when there are none.',
    '- "price", "originalPrice", "discount", "date", "address": copied from the request character for character, including the currency sign',
    '  or unit the user wrote (for example "¥199", "199 元", "8 折", "Rp 25.000"); "" when the user did not give it.',
    "Never invent, calculate, convert or reformat a number. Never invent prices, discounts, dates, sales figures, awards, certifications,",
    "phone numbers or brand names. A field the user did not provide stays empty.",
    "",
    "Reply with JSON only, no code fence and no text before or after it:",
    '{"background": "...", "template": "overlay", "title": "...", "titleLines": ["..."], "subtitle": "", "points": [],',
    ' "price": "", "originalPrice": "", "discount": "", "date": "", "address": ""}',
  ].join("\n");
}

/** Why a planner reply could not be used. */
export type PosterPlanFailure = "empty_reply" | "not_json" | "bad_shape";

export class PosterPlanError extends Error {
  constructor(readonly reason: PosterPlanFailure, readonly replyLength: number) {
    super(`invalid poster plan (${reason})`);
    this.name = "PosterPlanError";
  }
}

/** The reply as JSON. Models sometimes wrap it in a code fence or a sentence, so fall back to the outermost braces. */
function replyJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next reading.
    }
  }
  throw new PosterPlanError(trimmed ? "not_json" : "empty_reply", trimmed.length);
}

export interface PosterPlan {
  /** Picture description from the planner, before the composition and no-text rules are added. */
  background: string;
  layout: PosterLayout;
}

/**
 * Parse the planner's reply and check its numbers against `source`, the user's own request. A reply without a
 * picture prompt is an error: no paid image is sent from a broken plan.
 */
export function parsePosterPlan(text: string, source: string): PosterPlan {
  const plan = replyJson(text) as Record<string, unknown> | null;
  const fail = () => new PosterPlanError("bad_shape", text.trim().length);
  if (!plan || typeof plan !== "object") throw fail();
  const background = typeof plan.background === "string" ? plan.background.trim().slice(0, 1500) : "";
  if (!background) throw fail();
  const { fields, cleared } = verifyPosterFields(sanitizePosterFields(plan), source);
  const titleLines = fields.title ? acceptedTitleLines(fields.title, plan.titleLines) : undefined;
  return {
    background,
    layout: {
      version: POSTER_VERSION,
      template: parsePosterTemplate(plan.template) ?? DEFAULT_POSTER_TEMPLATE,
      fields,
      ...(titleLines ? { titleLines } : {}),
      ...(cleared.length ? { cleared } : {}),
    },
  };
}

/** Plan one poster. `complete` runs the text model and returns its raw reply. */
export async function planPoster(
  input: { prompt: string; referenceImages: number },
  complete: (system: string, user: string) => Promise<string>
): Promise<PosterPlan> {
  return parsePosterPlan(await complete(posterPlanSystemPrompt(input.referenceImages), input.prompt), input.prompt);
}

const FIELD_NAMES: readonly PosterFieldName[] = ["title", "subtitle", "points", "price", "originalPrice", "discount", "date", "address"];

/** A layout read back from message metadata or a job input; null for anything that is not one. */
export function parsePosterLayout(raw: unknown): PosterLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const template = parsePosterTemplate(value.template);
  if (!template || !value.fields || typeof value.fields !== "object") return null;
  const fields = sanitizePosterFields(value.fields);
  const manual = value.manualTitleLines === true;
  const titleLines = fields.title ? acceptedTitleLines(fields.title, value.titleLines, manual) : undefined;
  const cleared = Array.isArray(value.cleared) ? value.cleared.filter((name): name is PosterFieldName => FIELD_NAMES.includes(name)) : [];
  const url = (value.background as { url?: unknown } | undefined)?.url;
  return {
    version: POSTER_VERSION,
    template,
    fields,
    ...(value.style ? { style: parsePosterStyle(value.style) } : {}),
    ...(titleLines ? { titleLines, ...(manual ? { manualTitleLines: true } : {}) } : {}),
    ...(cleared.length ? { cleared } : {}),
    ...(typeof url === "string" && url ? { background: { url } } : {}),
    ...(value.overflow === true ? { overflow: true } : {}),
  };
}

/** Posters stored on a generation message, one per image (null where an image has none). */
export function storedPosters(raw: unknown): (PosterLayout | null)[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const posters = raw.map(parsePosterLayout);
  return posters.some(Boolean) ? posters : undefined;
}

export interface PosterLayoutEdit {
  fields?: unknown;
  template?: unknown;
  style?: unknown;
  titleLines?: unknown;
  manualTitleLines?: unknown;
}

/**
 * A user's edit applied to a stored poster. The user's own text is trusted (they typed it), so nothing is checked
 * against the request again; fields they filled are no longer marked as cleared, and the planner's title lines are
 * dropped once the title changes unless explicit manual breaks are provided.
 */
export function editPosterLayout(layout: PosterLayout, edit: PosterLayoutEdit): PosterLayout {
  const rawTitle = edit.fields && typeof edit.fields === "object" ? (edit.fields as Record<string, unknown>).title : undefined;
  const inlineManual = edit.titleLines === undefined ? parseManualTitleInput(rawTitle) : undefined;
  const fields = edit.fields === undefined
    ? layout.fields
    : sanitizePosterFields(inlineManual?.manualTitleLines ? { ...(edit.fields as Record<string, unknown>), title: inlineManual.title } : edit.fields);
  const template = parsePosterTemplate(edit.template) ?? layout.template;
  let titleLines: string[] | undefined;
  let manualTitleLines = false;
  if (inlineManual?.manualTitleLines && inlineManual.titleLines) {
    titleLines = acceptedTitleLines(fields.title, inlineManual.titleLines, true);
    manualTitleLines = !!titleLines;
  } else if (edit.titleLines !== undefined) {
    const manual = edit.manualTitleLines === true;
    titleLines = fields.title ? acceptedTitleLines(fields.title, edit.titleLines, manual) : undefined;
    manualTitleLines = manual && !!titleLines;
  } else if (fields.title === layout.fields.title) {
    titleLines = layout.titleLines;
    manualTitleLines = layout.manualTitleLines === true && !!titleLines;
  }
  return {
    version: POSTER_VERSION,
    template,
    fields,
    ...(edit.style !== undefined || layout.style ? { style: parsePosterStyle(edit.style ?? layout.style) } : {}),
    ...(titleLines ? { titleLines, ...(manualTitleLines ? { manualTitleLines: true } : {}) } : {}),
    ...(layout.background ? { background: layout.background } : {}),
  };
}
