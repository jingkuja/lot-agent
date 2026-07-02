import PptxGenJS from "pptxgenjs";
import type { PptTheme } from "./theme-extractor.js";

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
      slide.background = { color: c.accent1 };
      slide.addText(s.title, {
        x: W * 0.08, y: H * 0.34, w: W * 0.84, h: H * 0.22,
        fontFace: f.major, fontSize: 40, bold: true, color: c.lt1,
      });
      if (s.bullets?.length) {
        slide.addText(s.bullets.join("  ·  "), {
          x: W * 0.08, y: H * 0.6, w: W * 0.84, h: H * 0.1,
          fontFace: f.minor, fontSize: 16, color: c.lt2,
        });
      }
    } else if (s.layout === "section") {
      slide.background = { color: c.lt1 };
      slide.addShape(pptx.ShapeType.rect, {
        x: W * 0.08, y: H * 0.52, w: W * 0.2, h: 0.06,
        fill: { color: c.accent1 },
      });
      slide.addText(s.title, {
        x: W * 0.08, y: H * 0.36, w: W * 0.84, h: H * 0.16,
        fontFace: f.major, fontSize: 32, bold: true, color: c.dk1,
      });
    } else {
      slide.background = { color: c.lt1 };
      slide.addText(s.title, {
        x: W * 0.06, y: H * 0.05, w: W * 0.88, h: H * 0.12,
        fontFace: f.major, fontSize: 26, bold: true, color: c.dk1,
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: W * 0.06, y: H * 0.17, w: W * 0.12, h: 0.045,
        fill: { color: c.accent1 },
      });
      if (s.bullets?.length) {
        slide.addText(
          s.bullets.map((b) => ({
            text: b,
            options: { bullet: true, breakLine: true },
          })),
          {
            x: W * 0.07, y: H * 0.24, w: W * 0.86, h: H * 0.68,
            fontFace: f.minor, fontSize: 16, color: c.dk2, valign: "top",
          }
        );
      }
    }
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
