import { expect, it } from "vitest";
import JSZip from "jszip";
import { renderPptx } from "./renderer.js";
import { THEME_PRESETS } from "./themes.js";

it.each(["bar", "line", "pie"] as const)("exports an editable %s chart, embedded workbook, units, source and notes", async type => {
  const output = await renderPptx({ title: "经营复盘", slides: [{ layout: "chart", title: "收入增长", chart: {
    type, categories: ["Q1", "Q2"], series: [{ name: "收入", values: [10, 15] }], unit: "万元", source: "示例数据，仅用于测试",
  }, notes: "演讲备注" }] }, THEME_PRESETS.business);
  const zip = await JSZip.loadAsync(output);
  expect(zip.file(/ppt\/charts\/chart\d+\.xml/)).toHaveLength(1);
  expect(zip.file(/ppt\/embeddings\/.*\.xlsx/)).toHaveLength(1);
  const chart = await zip.file(/ppt\/charts\/chart\d+\.xml/)[0].async("string");
  expect(chart).toContain("Q1");
  expect(chart).toContain("15");
  expect(chart).toContain(`<c:${type}Chart>`);
  if (type === "pie") {
    expect(chart).toContain('formatCode="0%"');
    expect(chart).toContain('<c:showVal val="0"/>');
  }
  const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
  expect(slide).toContain("万元");
  expect(slide).toContain("示例数据，仅用于测试");
  expect(await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string")).toContain("演讲备注");
});
