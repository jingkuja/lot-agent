/**
 * Real-font posters (真实字体). The image model paints a background with no text; the server then typesets the
 * wording on top with real fonts. `PosterLayout` is the only source of a poster's text: it is planned once by a text
 * model, checked here in code, stored on the generation message and rendered again for free whenever the user edits
 * it. Nothing in this module touches fonts or pixels, so the web client shares it.
 */

export const POSTER_VERSION = 2;

export const POSTER_FONTS = ["sans", "serif"] as const;
export const POSTER_TITLE_WEIGHTS = ["regular", "bold"] as const;
export const POSTER_SCRIMS = ["auto", "soft", "strong"] as const;
export interface PosterStyle {
  font: typeof POSTER_FONTS[number];
  titleWeight: typeof POSTER_TITLE_WEIGHTS[number];
  scrim: typeof POSTER_SCRIMS[number];
}
export const DEFAULT_POSTER_STYLE: PosterStyle = { font: "sans", titleWeight: "bold", scrim: "auto" };

/** Only known styles reach Pango. Old layouts and unknown values retain the original appearance. */
export function parsePosterStyle(value: unknown): PosterStyle {
  const style = (value && typeof value === "object" ? value : {}) as Partial<PosterStyle>;
  return {
    font: POSTER_FONTS.includes(style.font!) ? style.font! : "sans",
    titleWeight: POSTER_TITLE_WEIGHTS.includes(style.titleWeight!) ? style.titleWeight! : "bold",
    scrim: POSTER_SCRIMS.includes(style.scrim!) ? style.scrim! : "auto",
  };
}

/**
 * Where the text goes. The three panel templates put it on a block of color taken from the picture, so it is always
 * readable; `overlay` writes straight onto the picture and relies on open space plus a scrim.
 */
export const POSTER_TEMPLATES = ["bottom_panel", "top_panel", "side_panel", "overlay"] as const;
export type PosterTemplate = typeof POSTER_TEMPLATES[number];
export const DEFAULT_POSTER_TEMPLATE: PosterTemplate = "bottom_panel";

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
  /** Title line breaks suggested by the planner; used only while they still spell the title exactly. */
  titleLines?: string[];
  /** Fields the planner filled with a number the user never wrote. They were emptied; the card asks the user to fill them. */
  cleared?: PosterFieldName[];
  /** The stored text-free picture this poster is rendered on. */
  background?: { url: string };
  /** The text did not fit even at the smallest size; the card suggests shortening it. */
  overflow?: boolean;
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

/** The planner's line breaks for a title, when joined they are the title itself and no line is a single character. */
export function acceptedTitleLines(title: string, suggested: unknown): string[] | undefined {
  if (!Array.isArray(suggested) || suggested.length < 2 || suggested.length > 3) return undefined;
  const lines = suggested.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (lines.some((item) => Array.from(item).length < 2)) return undefined;
  return comparable(lines.join("")) === comparable(title) ? lines : undefined;
}

const BREAK_AFTER = /[，。！？、；：,.!?;:\s]/;

/** Split `text` into `count` lines of similar length, breaking after punctuation or a space when one is near. */
function balancedLines(text: string, count: number): string[] | undefined {
  const chars = Array.from(text);
  if (chars.length < count * 2) return undefined;
  const lines: string[] = [];
  let start = 0;
  for (let part = 1; part < count; part++) {
    const ideal = Math.round(chars.length * part / count);
    const reach = Math.max(1, Math.floor(chars.length / count / 2));
    let cut = ideal;
    for (let offset = 0; offset <= reach; offset++) {
      const after = [ideal + offset, ideal - offset].find((index) => index - start >= 2 && chars.length - index >= 2 && BREAK_AFTER.test(chars[index - 1]));
      if (after !== undefined) {
        cut = after;
        break;
      }
    }
    if (cut - start < 2 || chars.length - cut < 2) return undefined;
    lines.push(chars.slice(start, cut).join("").trim());
    start = cut;
  }
  lines.push(chars.slice(start).join("").trim());
  return lines.every((item) => Array.from(item).length >= 2) ? lines : undefined;
}

/**
 * Ways to set a title, best first for a tie: on one line, as the planner suggested, or in two or three balanced
 * lines. The renderer picks whichever lets the type be largest. No option leaves a single character on a line.
 */
export function titleLineOptions(title: string, suggested?: unknown): string[][] {
  const options: string[][] = [[title]];
  const accepted = acceptedTitleLines(title, suggested);
  if (accepted) options.push(accepted);
  for (const count of [2, 3]) {
    const lines = balancedLines(title, count);
    if (lines && !options.some((option) => option.join("\n") === lines.join("\n"))) options.push(lines);
  }
  return options;
}

/**
 * The template actually used on a canvas: a side panel needs width and top / bottom panels need height, so each
 * falls back to the other on the wrong shape. Every template therefore works at any ratio.
 */
export function posterTemplateFor(template: PosterTemplate, width: number, height: number): PosterTemplate {
  const shape = width / height;
  if (template === "side_panel" && shape < 1.2) return "bottom_panel";
  if ((template === "bottom_panel" || template === "top_panel") && shape > 1.5) return "side_panel";
  return template;
}

const NO_TEXT = "Absolutely no text, letters, numbers, characters, logos, watermarks, signage or labels anywhere in the image.";

const COMPOSITION: Record<PosterTemplate, string> = {
  bottom_panel: "Composition: keep the main subject and every important detail within the top 60% of the frame. The bottom 40% will be "
    + "covered by a text panel, so let the scene simply continue there with plain, low-detail background.",
  top_panel: "Composition: keep the main subject and every important detail within the bottom 60% of the frame. The top 40% will be "
    + "covered by a text panel, so let the scene simply continue there with plain, low-detail background.",
  side_panel: "Composition: keep the main subject and every important detail within the right 55% of the frame. The left 45% will be "
    + "covered by a text panel, so let the scene simply continue there with plain, low-detail background.",
  overlay: "Composition: leave large clean copy space in the top 35% and the bottom 25% of the frame: smooth, even-toned, low-detail areas "
    + "such as sky, wall, table surface or soft gradient. Keep the main subject in the middle of the frame.",
};

/** The prompt sent to the image model: the planned picture plus the room the template needs and the no-text rule. */
export function posterBackgroundPrompt(prompt: string, template: PosterTemplate): string {
  return `${prompt.trim()}\n\n${COMPOSITION[template]}\n${NO_TEXT}`;
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
    '- "bottom_panel": picture on top, text panel at the bottom. The safe default for portrait and square posters.',
    '- "top_panel": text panel at the top, picture below.',
    '- "side_panel": text panel on the left, picture on the right. For landscape posters.',
    '- "overlay": wording written directly over the picture. Only for a title and one or two short lines on a calm picture.',
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
    '{"background": "...", "template": "bottom_panel", "title": "...", "titleLines": ["..."], "subtitle": "", "points": [],',
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
  const titleLines = fields.title ? acceptedTitleLines(fields.title, value.titleLines) : undefined;
  const cleared = Array.isArray(value.cleared) ? value.cleared.filter((name): name is PosterFieldName => FIELD_NAMES.includes(name)) : [];
  const url = (value.background as { url?: unknown } | undefined)?.url;
  return {
    version: POSTER_VERSION,
    template,
    fields,
    ...(value.style ? { style: parsePosterStyle(value.style) } : {}),
    ...(titleLines ? { titleLines } : {}),
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

/**
 * A user's edit applied to a stored poster. The user's own text is trusted (they typed it), so nothing is checked
 * against the request again; fields they filled are no longer marked as cleared, and the planner's title lines are
 * dropped once the title changes.
 */
export function editPosterLayout(layout: PosterLayout, edit: { fields?: unknown; template?: unknown; style?: unknown }): PosterLayout {
  const fields = edit.fields === undefined ? layout.fields : sanitizePosterFields(edit.fields);
  const template = parsePosterTemplate(edit.template) ?? layout.template;
  const titleLines = fields.title === layout.fields.title ? layout.titleLines : undefined;
  return {
    version: POSTER_VERSION,
    template,
    fields,
    ...(edit.style !== undefined || layout.style ? { style: parsePosterStyle(edit.style ?? layout.style) } : {}),
    ...(titleLines ? { titleLines } : {}),
    ...(layout.background ? { background: layout.background } : {}),
  };
}
