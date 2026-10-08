import { createRequire } from "node:module";
import type { PptTheme } from "./theme-extractor.js";
import { BUILDERS } from "./layouts/index.js";
import { inkColors, contrastInk, darken, type BuildCtx } from "./layouts/ctx.js";
import type { PptSlide } from "@lot-agent/core/presentation";
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

  outline.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    const addText = slide.addText.bind(slide);
    slide.addText = ((text: any, options: any = {}) => addText(text, fitText(text, options))) as typeof slide.addText;
    if (s.notes) slide.addNotes(s.notes);
    const ctx: BuildCtx = {
      c: theme.colors, f: theme.fonts,
      W: theme.slideWidthIn, H: theme.slideHeightIn, theme,
      index: i, total: outline.slides.length, presTitle: outline.title,
      agendaItems: sectionTitles,
      layout: s.layout,
    };
    (BUILDERS[s.layout] ?? BUILDERS.content)(slide, s, ctx);
    const source = s.layout === "chart" ? s.chart?.source : s.source;
    const sourceColor = ["cover", "closing"].includes(s.layout) && !theme.backgrounds?.cover ? contrastInk(darken(ctx.c.accent1, .25)) : inkColors(ctx).body;
    if (source) slide.addText(source, { x: ctx.W * 0.06, y: ctx.H * 0.885, w: ctx.W * 0.88, h: ctx.H * 0.035, fontSize: 9, fontFace: ctx.f.minor, color: sourceColor });
  });

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
