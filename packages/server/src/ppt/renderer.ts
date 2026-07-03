import { createRequire } from "node:module";
import type { PptTheme } from "./theme-extractor.js";

// pptxgenjs ships a dual CJS/ESM package.json "exports" map. Under tsx's dev
// loader (used by `npm run dev`), a plain `import PptxGenJS from "pptxgenjs"`
// resolves through a path that trips Node's ERR_REQUIRE_CYCLE_MODULE — the
// loader ends up synchronously require()-ing the ESM build mid-evaluation.
// Forcing a genuine CJS require via createRequire sidesteps that resolution
// path entirely (it loads dist/pptxgen.cjs.js directly, no cycle). Works
// identically under plain `node` (production/tsup build).
const require = createRequire(import.meta.url);
const PptxGenJS: typeof import("pptxgenjs").default = require("pptxgenjs");

export interface PptSlide {
  layout: "cover" | "section" | "content";
  title: string;
  bullets?: string[];
  notes?: string;
}

export interface PptOutline {
  title: string;
  slides: PptSlide[];
}

/** 把 hex 颜色调暗 amount（0-1），用于渐变终点或投影色。 */
function darken(hex: string, amount: number): string {
  const r = Math.round(parseInt(hex.slice(0, 2), 16) * (1 - amount));
  const g = Math.round(parseInt(hex.slice(2, 4), 16) * (1 - amount));
  const b = Math.round(parseInt(hex.slice(4, 6), 16) * (1 - amount));
  return [r, g, b]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

/** 大纲 + 主题 → .pptx 字节。纯函数，无 IO。 */
export async function renderPptx(
  outline: PptOutline,
  theme: PptTheme
): Promise<Buffer> {
  if (!outline.slides.length) {
    throw new Error("outline has no slides");
  }
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: "THEME",
    width: theme.slideWidthIn,
    height: theme.slideHeightIn,
  });
  pptx.layout = "THEME";
  const W = theme.slideWidthIn;
  const H = theme.slideHeightIn;
  const c = theme.colors;
  const f = theme.fonts;

  for (const s of outline.slides) {
    const slide = pptx.addSlide();
    if (s.notes) slide.addNotes(s.notes);

    if (s.layout === "cover") {
      buildCover(slide, s, c, f, W, H);
    } else if (s.layout === "section") {
      buildSection(slide, s, c, f, W, H);
    } else {
      buildContent(slide, s, c, f, W, H);
    }
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}

// ── cover ────────────────────────────────────────────────────────────────

function buildCover(
  slide: any,
  s: PptSlide,
  c: PptTheme["colors"],
  f: PptTheme["fonts"],
  W: number,
  H: number
) {
  const bottom = darken(c.accent1, 0.2);
  slide.background = { color: c.accent1 };
  // 渐变遮罩形状，让上方亮、下方暗
  slide.addShape("rect", {
    x: 0, y: 0, w: W, h: H,
    fill: {
      type: "gradient",
      gradientType: "linear",
      angle: 135,
      stops: [
        { color: c.accent1, position: 0 },
        { color: bottom, position: 100 },
      ],
    },
  });
  // 装饰圆形（右上角）
  slide.addShape("ellipse", {
    x: W * 0.72, y: -H * 0.18, w: H * 0.65, h: H * 0.65,
    fill: { color: "FFFFFF", transparency: 90 },
  });
  // 装饰圆形（左下角）
  slide.addShape("ellipse", {
    x: -W * 0.06, y: H * 0.72, w: H * 0.35, h: H * 0.35,
    fill: { color: "FFFFFF", transparency: 88 },
  });
  slide.addText(s.title, {
    x: W * 0.08, y: H * 0.32, w: W * 0.84, h: H * 0.24,
    fontFace: f.major, fontSize: 42, bold: true, color: c.lt1,
  });
  if (s.bullets?.length) {
    slide.addText(s.bullets.join("  ·  "), {
      x: W * 0.08, y: H * 0.6, w: W * 0.84, h: H * 0.12,
      fontFace: f.minor, fontSize: 16, color: c.lt2,
    });
  }
}

// ── section ──────────────────────────────────────────────────────────────

function buildSection(
  slide: any,
  s: PptSlide,
  c: PptTheme["colors"],
  f: PptTheme["fonts"],
  W: number,
  H: number
) {
  // 淡灰底色避免纯白
  slide.background = { color: c.lt2 };
  // 左侧宽色条（渐变）
  slide.addShape("rect", {
    x: 0, y: 0, w: W * 0.06, h: H,
    fill: {
      type: "gradient",
      gradientType: "linear",
      angle: 180,
      stops: [
        { color: c.accent1, position: 0 },
        { color: darken(c.accent1, 0.15), position: 100 },
      ],
    },
  });
  // 底部细线
  slide.addShape("rect", {
    x: W * 0.06, y: H - 0.05, w: W * 0.94, h: 0.05,
    fill: { color: c.accent1 },
  });
  slide.addText(s.title, {
    x: W * 0.12, y: H * 0.33, w: W * 0.82, h: H * 0.22,
    fontFace: f.major, fontSize: 36, bold: true, color: c.dk1,
  });
}

// ── content ──────────────────────────────────────────────────────────────

function buildContent(
  slide: any,
  s: PptSlide,
  c: PptTheme["colors"],
  f: PptTheme["fonts"],
  W: number,
  H: number
) {
  slide.background = { color: c.lt2 };
  // 顶部色条
  slide.addShape("rect", {
    x: 0, y: 0, w: W, h: 0.07,
    fill: { color: c.accent1 },
  });
  // 标题
  slide.addText(s.title, {
    x: W * 0.06, y: H * 0.07, w: W * 0.88, h: H * 0.13,
    fontFace: f.major, fontSize: 28, bold: true, color: c.dk1,
  });
  // 标题下方 accent 下划线
  slide.addShape("rect", {
    x: W * 0.06, y: H * 0.2, w: W * 0.14, h: 0.04,
    fill: { color: c.accent1 },
  });
  // 正文 bullet 列表
  if (s.bullets?.length) {
    slide.addText(
      s.bullets.map((b) => ({
        text: b,
        options: { bullet: { color: c.accent1 }, breakLine: true, paraSpaceAfter: 6 },
      })),
      {
        x: W * 0.07, y: H * 0.27, w: W * 0.86, h: H * 0.63,
        fontFace: f.minor, fontSize: 16, color: c.dk2, valign: "top",
      }
    );
  }
}
