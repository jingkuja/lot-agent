/** Browser-safe presentation contract shared by planning, editing and export. */
export const PPT_LAYOUTS = ["cover", "agenda", "section", "content", "keypoints", "stats", "compare", "timeline", "chart", "quote", "closing"] as const;
export const PPT_THEMES = ["business", "tech-dark", "warm", "mono", "academic"] as const;
export const PPT_ICONS = ["target", "trend", "check", "people", "clock", "shield"] as const;
export type PptLayout = typeof PPT_LAYOUTS[number];
export interface PptItem { label: string; value?: string; desc?: string; icon?: typeof PPT_ICONS[number] }
export interface PptColumn { title: string; bullets: string[] }
export interface PptQuote { text: string; author?: string }
export interface PptChart {
  type: "bar" | "line" | "pie";
  categories: string[];
  series: { name: string; values: number[] }[];
  unit: string;
  source: string;
}
export interface PptSlide {
  layout: PptLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  items?: PptItem[];
  left?: PptColumn;
  right?: PptColumn;
  quote?: PptQuote;
  chart?: PptChart;
  source?: string;
  notes?: string;
}
export interface PptBrief {
  audience?: string;
  objective?: string;
  durationMinutes?: number;
  targetSlides?: number;
  contentMode?: "generate" | "condense" | "preserve";
  /** Explicitly disclose reasonable defaults rather than asking repeatedly. */
  assumptions?: string[];
}
export interface PptDeck {
  title: string;
  slides: PptSlide[];
  brief?: PptBrief;
  themePreset?: typeof PPT_THEMES[number];
  templateAssetId?: string;
  backgrounds?: { assetId: string; role?: "cover" | "body" | "section"; overlay?: "dark" | "light" | "none" }[];
}
export interface PptWarning { code: string; message: string; slide?: number }

export const PPT_APPROVAL_PREFIX = "[lot-ppt-confirmation:v1]\n";
export const PPT_ARTIFACT_PREFIX = "ppt_artifact: ";
export const MAX_DECK_CHARACTERS = 160_000;

export function encodePptApproval(deck: PptDeck): string {
  return PPT_APPROVAL_PREFIX + JSON.stringify(deck);
}
/** null means ordinary chat. A malformed explicit action must never fall through to an LLM. */
export function parsePptApproval(message: string): PptDeck | null {
  if (!message.startsWith(PPT_APPROVAL_PREFIX)) return null;
  if (message.length > MAX_DECK_CHARACTERS + PPT_APPROVAL_PREFIX.length) throw new Error("PPT confirmation is too large.");
  let input: unknown;
  try { input = JSON.parse(message.slice(PPT_APPROVAL_PREFIX.length)); }
  catch { throw new Error("Invalid PPT confirmation."); }
  const error = validateDeck(input);
  if (error) throw new Error(error);
  return input as PptDeck;
}

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && !!v.trim();

/** Approximate rendered width in CJK characters, allowing longer Latin wording. */
export function textUnits(text: string): number {
  return Array.from(text).reduce((n, c) => n + (/\s/u.test(c) ? 0.35 : /[\u0020-\u024f]/u.test(c) ? 0.55 : 1), 0);
}
function textError(value: unknown, path: string, budget: number, required = false): string | null {
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || (required && !value.trim())) return `${path} 需要非空文本。`;
  if (textUnits(value) > budget || value.split(/\r?\n/).length > 3) {
    return `${path} 超出版面预算（约 ${budget} 个中文字或等宽英文）。请精简、拆页，或将细节移入 notes；不要截断事实。`;
  }
  return null;
}
function listError(value: unknown, path: string, min: number, max: number, budget: number): string | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return `${path} 需要 ${min}-${max} 条。`;
  for (let i = 0; i < value.length; i++) {
    const error = textError(value[i], `${path}[${i + 1}]`, budget, true);
    if (error) return error;
  }
  return null;
}

/** Runtime validation applies even to direct UI confirmations and persisted history. */
export function validateSlides(slides: unknown): string | null {
  if (!Array.isArray(slides) || !slides.length) return "slides 需为非空数组（至少一页）。";
  if (slides.length > 40) return "slides 过多（最多 40 页）。";
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const at = `第 ${i + 1} 页`;
    if (!object(s) || !PPT_LAYOUTS.includes(s.layout)) return `${at}.layout 非法。`;
    if (typeof s.title !== "string") return `${at}.title 需要文本。`;
    const fields: Record<string, string[]> = { cover: ["bullets"], content: ["bullets"], agenda: ["items"], keypoints: ["items"], stats: ["items"], timeline: ["items"], compare: ["left", "right"], quote: ["quote"], chart: ["chart"] };
    for (const key of ["bullets", "items", "left", "right", "quote", "chart"]) {
      if (s[key] !== undefined && !fields[s.layout]?.includes(key)) return `${at}.${key} 不属于 ${s.layout} 版式，请选择匹配的版式或移入 notes。`;
    }
    if (s.subtitle && !["cover", "section", "closing"].includes(s.layout)) return `${at}.subtitle 仅用于 cover/section/closing，其余说明请放入正文或 notes。`;
    if (s.layout === "cover" && s.subtitle && s.bullets) return `${at} 的副标题和 bullets 请合并为 subtitle，避免内容遗漏。`;
    for (const [key, max, required] of [["title", 44, s.layout !== "quote"], ["subtitle", 90, false], ["source", 90, false]] as const) {
      const error = textError(s[key], `${at}.${key}`, max, required);
      if (error) return error;
    }
    if (s.notes !== undefined && (typeof s.notes !== "string" || s.notes.length > 4000)) return `${at}.notes 需为最多 4000 字的文本。`;
    if (s.bullets !== undefined || s.layout === "content") {
      const error = listError(s.bullets, `${at}.bullets`, 1, 8, 64);
      if (error) return error;
      if (s.bullets.reduce((n: number, b: string) => n + textUnits(b), 0) > 280) return `${at}.bullets 总字数超出 280 字预算，请拆页或转入 notes。`;
    }
    if (s.items !== undefined || ["keypoints", "stats", "timeline"].includes(s.layout)) {
      const max = s.layout === "stats" ? 4 : s.layout === "agenda" ? 8 : 6;
      const min = s.layout === "timeline" ? 3 : 2;
      if (!Array.isArray(s.items) || s.items.length < min || s.items.length > max) return `${at}(${s.layout}).items 需要 ${min}-${max} 项。`;
      for (let j = 0; j < s.items.length; j++) {
        const item = s.items[j];
        if (!object(item)) return `${at}.items[${j + 1}] 需要对象。`;
        const visibleFields: Record<string, string[]> = { agenda: [], keypoints: ["desc", "icon"], stats: ["desc", "value"], timeline: ["desc"] };
        for (const key of ["desc", "value", "icon"]) {
          if (item[key] !== undefined && !visibleFields[s.layout]?.includes(key)) return `${at}.items[${j + 1}].${key} 不属于 ${s.layout} 版式，请选择匹配的版式或移入 notes。`;
        }
        const compact = s.layout === "timeline" || s.layout === "stats" || s.items.length > 4;
        for (const [key, max, required] of [["label", compact ? 18 : 28, true], ["value", 12, s.layout === "stats"], ["desc", compact ? 32 : 55, false]] as const) {
          const error = textError(item[key], `${at}.items[${j + 1}].${key}`, max, required);
          if (error) return error;
        }
        if (item.icon !== undefined && !PPT_ICONS.includes(item.icon)) return `${at}.items[${j + 1}].icon 非法。`;
      }
    }
    for (const key of ["left", "right"] as const) {
      if (s[key] !== undefined || s.layout === "compare") {
        if (!object(s[key])) return `${at}(compare).${key} 需要 title 与 bullets。`;
        const error = textError(s[key].title, `${at}.${key}.title`, 24, true) || listError(s[key].bullets, `${at}.${key}.bullets`, 1, 5, 48);
        if (error) return error;
        if (s[key].bullets.reduce((n: number, b: string) => n + textUnits(b), 0) > 150) return `${at}.${key}.bullets 总字数超出 150 字预算。`;
      }
    }
    if (s.quote !== undefined || s.layout === "quote") {
      if (!object(s.quote)) return `${at}.quote 需要非空 text。`;
      const error = textError(s.quote.text, `${at}.quote.text`, 90, true) || textError(s.quote.author, `${at}.quote.author`, 36);
      if (error) return error;
    }
    if (s.chart !== undefined || s.layout === "chart") {
      const c = s.chart;
      if (!object(c) || !["bar", "line", "pie"].includes(c.type)) return `${at}.chart.type 需为 bar/line/pie。`;
      const error = listError(c.categories, `${at}.chart.categories`, 2, 8, 16) || textError(c.source, `${at}.chart.source`, 90, true) || textError(c.unit, `${at}.chart.unit`, 16, true);
      if (error) return error;
      if (!Array.isArray(c.series) || c.series.length < 1 || c.series.length > 3) return `${at}.chart.series 需要 1-3 组数据。`;
      for (const series of c.series) {
        if (!object(series)) return `${at}.chart.series 非法。`;
        const nameError = textError(series.name, `${at}.chart.series.name`, 24, true);
        if (nameError) return nameError;
        if (!Array.isArray(series.values) || series.values.length !== c.categories.length || !series.values.every((v: unknown) => typeof v === "number" && Number.isFinite(v))) return `${at}.chart.series.values 需为有限数字，数量与 categories 一致；缺失值不能写成 0。`;
      }
      if (c.type === "pie" && (c.series.length !== 1 || c.series[0].values.some((v: number) => v < 0) || !c.series[0].values.some((v: number) => v > 0))) return `${at}.chart pie 只允许一组非负且不全为 0 的数据。`;
    }
  }
  return null;
}

export function validateDeck(input: unknown): string | null {
  if (!object(input)) return "PPT 需要对象。";
  const error = textError(input.title, "title", 60, true) || validateSlides(input.slides);
  if (error) return error;
  if (JSON.stringify(input).length > MAX_DECK_CHARACTERS) return "PPT 内容过大，请拆分文稿。";
  if (input.themePreset !== undefined && !PPT_THEMES.includes(input.themePreset)) return "themePreset 非法。";
  if (input.templateAssetId !== undefined && (!nonEmpty(input.templateAssetId) || input.templateAssetId.length > 200)) return "templateAssetId 非法。";
  if (input.backgrounds !== undefined) {
    if (!Array.isArray(input.backgrounds) || input.backgrounds.length > 3) return "backgrounds 最多 3 张。";
    for (const bg of input.backgrounds) {
      if (!object(bg) || !nonEmpty(bg.assetId) || bg.assetId.length > 200 || (bg.role !== undefined && !["cover", "body", "section"].includes(bg.role)) || (bg.overlay !== undefined && !["dark", "light", "none"].includes(bg.overlay))) return "backgrounds 的 assetId/role/overlay 非法。";
    }
  }
  if (input.brief !== undefined) {
    const b = input.brief;
    if (!object(b)) return "brief 非法。";
    for (const key of ["audience", "objective"] as const) {
      const error = textError(b[key], `brief.${key}`, 120);
      if (error) return error;
    }
    if (b.durationMinutes !== undefined && (!Number.isFinite(b.durationMinutes) || b.durationMinutes <= 0 || b.durationMinutes > 480)) return "brief.durationMinutes 需为 0-480 分钟。";
    if (b.targetSlides !== undefined && (!Number.isInteger(b.targetSlides) || b.targetSlides !== input.slides.length)) return `页数须符合已约定的 ${b.targetSlides} 页（包含封面与结尾）。`;
    if (b.contentMode !== undefined && !["generate", "condense", "preserve"].includes(b.contentMode)) return "brief.contentMode 非法。";
    if (b.assumptions !== undefined) {
      const error = listError(b.assumptions, "brief.assumptions", 0, 4, 120);
      if (error) return error;
    }
  }
  return null;
}

/** Editorial advice is non-blocking: valid short decks need no artificial agenda or dividers. */
export function inspectDeck(deck: PptDeck): PptWarning[] {
  const warnings: PptWarning[] = [];
  const titles = new Set<string>();
  deck.slides.forEach((slide, i) => {
    if (titles.has(slide.title.trim()) && slide.title.trim()) warnings.push({ code: "repeated-title", slide: i + 1, message: `第 ${i + 1} 页标题重复，建议写明本页结论。` });
    titles.add(slide.title.trim());
    if (i >= 2 && [i - 2, i - 1, i].every(n => deck.slides[n].layout === "content")) warnings.push({ code: "layout-rhythm", slide: i + 1, message: `第 ${i - 1}–${i + 1} 页连续使用要点列表，可按内容改成对比、流程或卡片。` });
    if (slide.layout === "stats" && !slide.source) warnings.push({ code: "missing-source", slide: i + 1, message: `第 ${i + 1} 页数据未标注来源，请核实。` });
    if (slide.layout === "agenda" && !slide.items && !deck.slides.some(s => s.layout === "section")) warnings.push({ code: "empty-agenda", slide: i + 1, message: `第 ${i + 1} 页目录没有条目，请补充或删除。` });
  });
  return warnings;
}

export interface PptArtifact {
  version: 1;
  deck: PptDeck;
  warnings: PptWarning[];
  previewUrls?: string[];
  previewStatus?: "ready" | "unavailable";
}
export function parsePptArtifact(output: string): PptArtifact | null {
  const line = output.split("\n").find(line => line.startsWith(PPT_ARTIFACT_PREFIX));
  if (!line || line.length > MAX_DECK_CHARACTERS + 30000) return null;
  try {
    const value = JSON.parse(line.slice(PPT_ARTIFACT_PREFIX.length));
    if (!object(value) || value.version !== 1 || validateDeck(value.deck)) return null;
    // Historical results and remote URLs are untrusted at the browser boundary.
    const safeUrl = (url: unknown): url is string => typeof url === "string" && /^(?:https?:\/\/[^/]+)?\/static\/documents\/[\w.-]+\.png$/.test(url);
    const previewUrls = Array.isArray(value.previewUrls) && value.previewUrls.length === value.deck.slides.length && value.previewUrls.every(safeUrl) ? value.previewUrls : [];
    return { version: 1, deck: value.deck, warnings: Array.isArray(value.warnings) ? value.warnings.filter((w: unknown) => object(w) && typeof w.message === "string") : [], previewUrls, previewStatus: previewUrls.length ? "ready" : "unavailable" };
  } catch { return null; }
}
