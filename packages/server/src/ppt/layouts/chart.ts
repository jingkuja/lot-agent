import type { PptSlide } from "../renderer.js";
import { fitRows, textHeight } from "../text-fit.js";
import { type BuildCtx, type PptxSlide, drawCard, drawFooter, drawHeading, inkColors, pageBackground, palette, seriesColors } from "./ctx.js";

/** Native editable chart in one accent plus neutrals; optional takeaways sit beside it. */
export function buildChart(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { f } = ctx;
  pageBackground(slide, ctx);
  const p = palette(ctx);
  const ink = inkColors(ctx);
  const frame = drawHeading(slide, s.title, ctx);
  const chart = s.chart!;
  const insights = s.bullets ?? [];
  const panelW = insights.length ? Math.min(4.2, frame.w * 0.34) : 0;
  const chartW = frame.w - (panelW ? panelW + 0.45 : 0);
  const top = frame.top - 0.1, height = frame.bottom - top;
  slide.addText(chart.unit, { x: frame.x, y: top, w: chartW, h: 0.3, fontFace: f.minor, fontSize: 12, color: ink.body });
  const colors = chart.type === "pie" ? seriesColors(ctx, chart.categories.length) : seriesColors(ctx, chart.series.length);
  const axis = ink.onBg ? ink.body : p.body;
  slide.addChart(chart.type, chart.series.map(series => ({ name: series.name, labels: chart.categories, values: series.values })), {
    x: frame.x, y: top + 0.35, w: chartW, h: height - 0.35,
    catAxisLabelFontFace: f.minor, catAxisLabelFontSize: 12, catAxisLabelColor: axis,
    valAxisLabelFontFace: f.minor, valAxisLabelFontSize: 11, valAxisLabelColor: axis,
    legendFontFace: f.minor, legendFontSize: 12, legendColor: axis, legendPos: chart.type === "pie" ? "r" : "t",
    showLegend: chart.type === "pie" || chart.series.length > 1,
    showValue: chart.type !== "pie" && chart.categories.length <= 6,
    showPercent: chart.type === "pie",
    showLeaderLines: chart.type === "pie",
    dataLabelColor: ink.onBg ? ink.title : p.title, dataLabelFontSize: 11, dataLabelFontFace: f.minor,
    dataLabelFormatCode: chart.type === "pie" ? "0%" : "0.##", dataLabelPosition: chart.type === "line" ? "t" : "outEnd",
    chartColors: colors,
    chartArea: { fill: { color: p.page, transparency: 100 }, border: { color: p.page, pt: 0 } },
    plotArea: { fill: { color: p.page, transparency: 100 }, border: { color: p.page, pt: 0 } },
    catAxisLineShow: chart.type !== "pie", catAxisLineColor: p.line, valAxisLineShow: false, valAxisHidden: chart.type === "bar" && chart.categories.length <= 6,
    showBorder: false, showTitle: false,
    valGridLine: { color: p.line, width: 0.5 }, catGridLine: { style: "none" },
    showMarker: chart.type === "line", lineSize: 2.5, markerSize: 6,
    barDir: "col", barGapWidthPct: chart.series.length > 1 ? 60 : 90, catAxisLabelRotate: 0, showShadow: false,
    holeSize: 0,
  });
  if (insights.length) {
    const x = frame.x + chartW + 0.45;
    const panelH = height - 0.35;
    const card = drawCard(slide, ctx, { x, y: top + 0.35, w: panelW, h: panelH });
    const inner = panelW - 0.8;
    const fit = fitRows(size => insights.map(text => textHeight(text, size, inner, 1.12)), panelH - 0.52, [18, 16, 14, 12, 11, 10], 0.16, 0.32);
    let y = top + 0.35 + (panelH - fit.total) / 2;
    insights.forEach((text, i) => {
      slide.addShape("rect", { x: x + 0.24, y: y + 0.12, w: 0.08, h: 0.08, fill: { color: p.accent }, line: { type: "none" } });
      slide.addText(text, {
        x: x + 0.5, y, w: inner, h: fit.rows[i], fontFace: f.minor, fontSize: fit.size, color: card.title, valign: "top", lineSpacingMultiple: 1.12,
      });
      y += fit.rows[i] + fit.gap;
    });
  }
  drawFooter(slide, ctx);
}
