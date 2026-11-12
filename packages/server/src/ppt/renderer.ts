import { createRequire } from "node:module";
import JSZip from "jszip";
import type PptxLibrary from "pptxgenjs";
import { DEFAULT_THEME, type PptTheme } from "./theme-extractor.js";
import { BUILDERS } from "./layouts/index.js";
import { drawSource, type BuildCtx } from "./layouts/ctx.js";
import { TABLE_OBJECT_NAME } from "./layouts/table.js";
import type { PptLayout, PptSlide } from "@lot-agent/core/presentation";
import { fitText } from "./text-fit.js";
export type { PptLayout, PptItem, PptColumn, PptQuote, PptChart, PptSlide } from "@lot-agent/core/presentation";

// pptxgenjs ships a dual CJS/ESM package.json "exports" map. Under tsx's dev
// loader (used by `pnpm run dev`), a plain `import PptxGenJS from "pptxgenjs"`
// resolves through a path that trips Node's ERR_REQUIRE_CYCLE_MODULE — the
// loader ends up synchronously require()-ing the ESM build mid-evaluation.
// Forcing a genuine CJS require via createRequire sidesteps that resolution
// path entirely (it loads dist/pptxgen.cjs.js directly, no cycle). Works
// identically under plain `node` (production/tsup build).
const require = createRequire(import.meta.url);
const PptxGenJS: typeof import("pptxgenjs").default = require("pptxgenjs");

export interface PptOutline { title: string; slides: PptSlide[] }

/** Preserve the template's physical page size while giving layouts room on smaller slides. */
function configureSlide(slide: PptxLibrary.Slide, scale: number): void {
  const length = <T extends number | string | undefined>(n: T) => typeof n === "number" ? n * scale : n;
  const box = <T extends PptxLibrary.PositionProps>(o: T) => ({ ...o, x: length(o.x), y: length(o.y), w: length(o.w), h: length(o.h) });
  const font = (size?: number) => size === undefined ? undefined : Math.max(1, Math.round(size * scale));
  const addText = slide.addText.bind(slide);
  slide.addText = (text, options = {}) => {
    const fitted: PptxLibrary.TextPropsOptions = fitText(text, options);
    return addText(text, scale === 1 ? fitted : { ...box(fitted), fontSize: font(fitted.fontSize) });
  };
  if (scale === 1) return;
  const addShape = slide.addShape.bind(slide);
  slide.addShape = (type, options = {}) => addShape(type, { ...box(options), rectRadius: length(options.rectRadius) });
  const addChart = slide.addChart.bind(slide);
  slide.addChart = (type, data, options = {}) => addChart(type, data, {
    ...box(options), catAxisLabelFontSize: font(options.catAxisLabelFontSize), valAxisLabelFontSize: font(options.valAxisLabelFontSize),
    dataLabelFontSize: font(options.dataLabelFontSize), legendFontSize: font(options.legendFontSize),
  });
  const inches = (value?: number | number[]) => Array.isArray(value) ? value.map(n => n * scale) : length(value);
  const addTable = slide.addTable.bind(slide);
  slide.addTable = (rows, options = {}) => addTable(rows, {
    ...box(options), colW: inches(options.colW), rowH: inches(options.rowH), fontSize: font(options.fontSize),
    margin: Array.isArray(options.margin) ? options.margin.map(n => n * scale) as typeof options.margin : length(options.margin),
  });
}

/** PptxGenJS assigns table IDs from the slide number, which can collide with text or shape IDs. */
async function fixTableShapeIds(buffer: Buffer, slideNumbers: number[]): Promise<Buffer> {
  if (!slideNumbers.length) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  for (const number of slideNumbers) {
    const path = `ppt/slides/slide${number}.xml`;
    const xml = await zip.file(path)!.async("string");
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(match => Number(match[1]));
    const pattern = new RegExp(`<p:cNvPr id="(\\d+)" name="${TABLE_OBJECT_NAME}"`);
    const match = xml.match(pattern);
    if (match && ids.filter(id => id === Number(match[1])).length > 1) {
      zip.file(path, xml.replace(pattern, `<p:cNvPr id="${Math.max(...ids) + 1}" name="${TABLE_OBJECT_NAME}"`));
    }
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 大纲 + 主题 → .pptx 字节。纯函数，无 IO。 */
export async function renderPptx(outline: PptOutline, theme: PptTheme): Promise<Buffer> {
  if (!outline.slides.length) throw new Error("outline has no slides");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "THEME", width: theme.slideWidthIn, height: theme.slideHeightIn });
  pptx.layout = "THEME";
  pptx.title = outline.title;
  pptx.subject = outline.title;
  pptx.author = "Lot Agent";
  pptx.theme = { headFontFace: theme.fonts.major, bodyFontFace: theme.fonts.minor };

  const sectionTitles = outline.slides.filter((x) => x.layout === "section").map((x) => x.title);
  const occurrences = new Map<PptLayout, number>();
  const tableSlides: number[] = [];
  const scale = Math.min(1, theme.slideWidthIn / DEFAULT_THEME.slideWidthIn, theme.slideHeightIn / DEFAULT_THEME.slideHeightIn);

  outline.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    configureSlide(slide, scale);
    if (s.notes) slide.addNotes(s.notes);
    const occurrence = occurrences.get(s.layout) ?? 0;
    occurrences.set(s.layout, occurrence + 1);
    const ctx: BuildCtx = {
      c: theme.colors, f: theme.fonts,
      W: theme.slideWidthIn / scale, H: theme.slideHeightIn / scale, theme,
      index: i, total: outline.slides.length, presTitle: outline.title,
      agendaItems: sectionTitles,
      layout: s.layout,
      occurrence,
    };
    (BUILDERS[s.layout] ?? BUILDERS.content)(slide, s, ctx);
    if (s.layout === "table") tableSlides.push(i + 1);
    if (s.layout !== "cover" && s.layout !== "closing") drawSource(slide, s.chart?.source ?? s.source, ctx);
  });

  const out = await pptx.write({ outputType: "nodebuffer" });
  return fixTableShapeIds(out as Buffer, tableSlides);
}
