import type PptxGenJS from "pptxgenjs";
import type { PptSlide } from "../renderer.js";
import { linesFor } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, drawFooter, drawHeading, pageBackground, palette, settle } from "./ctx.js";

export const TABLE_OBJECT_NAME = "Data Table";

export function buildTable(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  pageBackground(slide, ctx);
  const p = palette(ctx);
  const frame = drawHeading(slide, s.title, ctx);
  const { columns, rows } = s.table!;
  const cells = [columns, ...rows];
  const colW = frame.w / columns.length;
  const marginX = 0.12;
  const marginY = rows.length > 5 ? 0.028 : 0.09;
  const available = frame.bottom - frame.top;
  const heights = (size: number) => cells.map(row => {
    const lines = Math.max(...row.map(text => linesFor(text, size, colW - marginX * 2)));
    return lines * size * 1.28 / 72 + marginY * 2;
  });
  const total = (rowHeights: number[]) => rowHeights.reduce((sum, h) => sum + h, 0);
  let size = columns.length > 4 || rows.length > 5 ? 15 : 18;
  let rowH = heights(size);
  while (total(rowH) > available && size > 6) rowH = heights(--size);
  const h = total(rowH);

  const data: PptxGenJS.TableRow[] = cells.map((row, i) => row.map(text => ({
    text,
    options: { bold: i === 0, color: i === 0 ? p.onAccent : p.title, fill: { color: i === 0 ? p.accent : i % 2 ? p.surface : p.soft } },
  })));
  const options: PptxGenJS.TableProps = {
    x: frame.x, y: settle(frame, h), w: frame.w, h, rowH, colW,
    margin: [marginY, marginX, marginY, marginX], autoPage: false, valign: "middle",
    fontFace: ctx.f.minor, fontSize: size, border: { type: "solid", color: p.line, pt: 0.5 }, objectName: TABLE_OBJECT_NAME,
  };
  slide.addTable(data, options);
  drawFooter(slide, ctx);
}
