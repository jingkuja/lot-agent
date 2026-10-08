import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, applyBackground, inkColors, drawFooter } from "./ctx.js";

export function buildChart(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  if (!applyBackground(slide, ctx)) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
  const chart = s.chart!;
  slide.addText(s.title, { x: W * 0.06, y: H * 0.07, w: W * 0.88, h: H * 0.13, fontFace: f.major, fontSize: 32, bold: true, color: ink.title });
  slide.addText(chart.unit, { x: W * 0.06, y: H * 0.21, w: W * 0.88, h: H * 0.05, fontFace: f.minor, fontSize: 12, color: ink.body });
  slide.addChart(chart.type, chart.series.map(series => ({ name: series.name, labels: chart.categories, values: series.values })), {
    x: W * 0.06, y: H * 0.29, w: W * 0.88, h: H * 0.56,
    catAxisLabelFontFace: f.minor, catAxisLabelFontSize: 12, catAxisLabelColor: c.dk2,
    valAxisLabelFontFace: f.minor, valAxisLabelFontSize: 11, valAxisLabelColor: c.dk2,
    legendFontFace: f.minor, legendFontSize: 12, legendColor: c.dk2, legendPos: "b",
    showLegend: chart.type === "pie" || chart.series.length > 1,
    showValue: chart.type !== "pie" && chart.categories.length <= 6,
    showPercent: chart.type === "pie",
    dataLabelColor: c.dk1, dataLabelFormatCode: chart.type === "pie" ? "0%" : "0.##", dataLabelPosition: chart.type === "bar" ? "outEnd" : "bestFit",
    chartColors: [c.accent1, c.accent2, c.accent3, c.accent4, c.accent5, c.accent6],
    chartArea: { fill: { color: c.lt2 }, border: { color: c.lt2, pt: 0 } },
    plotArea: { fill: { color: c.lt2 }, border: { color: c.lt2, pt: 0 } },
    catAxisLineShow: false, valAxisLineShow: false, showBorder: false, showTitle: false,
    valGridLine: { color: c.dk2, transparency: 85, width: 0.5 },
    showMarker: chart.type === "line", lineSize: 2.5, markerSize: 5,
    barDir: "col", catAxisLabelRotate: 0, showShadow: false,
  });
  drawFooter(slide, ctx);
}
