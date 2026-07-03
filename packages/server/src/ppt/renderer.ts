import { createRequire } from "node:module";
import type { PptTheme } from "./theme-extractor.js";
import { BUILDERS } from "./layouts/index.js";
import type { BuildCtx } from "./layouts/ctx.js";

// pptxgenjs ships a dual CJS/ESM package.json "exports" map. Under tsx's dev
// loader (used by `npm run dev`), a plain `import PptxGenJS from "pptxgenjs"`
// resolves through a path that trips Node's ERR_REQUIRE_CYCLE_MODULE — the
// loader ends up synchronously require()-ing the ESM build mid-evaluation.
// Forcing a genuine CJS require via createRequire sidesteps that resolution
// path entirely (it loads dist/pptxgen.cjs.js directly, no cycle). Works
// identically under plain `node` (production/tsup build).
const require = createRequire(import.meta.url);
const PptxGenJS: typeof import("pptxgenjs").default = require("pptxgenjs");

export type PptLayout =
  | "cover" | "agenda" | "section" | "content" | "keypoints"
  | "stats" | "compare" | "timeline" | "quote" | "closing";
export interface PptItem { label: string; value?: string; desc?: string }
export interface PptColumn { title: string; bullets: string[] }
export interface PptQuote { text: string; author?: string }
export interface PptSlide {
  layout: PptLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  items?: PptItem[];
  left?: PptColumn;
  right?: PptColumn;
  quote?: PptQuote;
  notes?: string;
}
export interface PptOutline { title: string; slides: PptSlide[] }

/** 大纲 + 主题 → .pptx 字节。纯函数，无 IO。 */
export async function renderPptx(outline: PptOutline, theme: PptTheme): Promise<Buffer> {
  if (!outline.slides.length) throw new Error("outline has no slides");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "THEME", width: theme.slideWidthIn, height: theme.slideHeightIn });
  pptx.layout = "THEME";

  const sectionTitles = outline.slides.filter((x) => x.layout === "section").map((x) => x.title);

  outline.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    if (s.notes) slide.addNotes(s.notes);
    const ctx: BuildCtx = {
      c: theme.colors, f: theme.fonts,
      W: theme.slideWidthIn, H: theme.slideHeightIn, theme,
      index: i, total: outline.slides.length, presTitle: outline.title,
      agendaItems: sectionTitles,
      layout: s.layout,
    };
    (BUILDERS[s.layout] ?? BUILDERS.content)(slide, s, ctx);
  });

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
