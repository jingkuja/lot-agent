import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { renderPptx, type PptOutline } from "./renderer.js";
import { DEFAULT_THEME } from "./theme-extractor.js";

async function slideXml(outline: PptOutline, n: number): Promise<string> {
  const buf = await renderPptx(outline, DEFAULT_THEME);
  const zip = await JSZip.loadAsync(buf);
  return zip.file(`ppt/slides/slide${n}.xml`)!.async("string");
}

describe("new layouts render their content", () => {
  it("stats places every value and label", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "stats", title: "核心数据", items: [{ value: "65%", label: "增长" }, { value: "3x", label: "效率" }] },
    ]}, 1);
    expect(xml).toContain("65%");
    expect(xml).toContain("增长");
    expect(xml).toContain("3x");
  });
  it("compare places both column titles and bullets", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "compare", title: "新老对比", left: { title: "旧策略", bullets: ["投放广"] }, right: { title: "新策略", bullets: ["精准"] } },
    ]}, 1);
    expect(xml).toContain("旧策略");
    expect(xml).toContain("新策略");
    expect(xml).toContain("投放广");
    expect(xml).toContain("精准");
  });
  it("timeline places every node label", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "timeline", title: "节奏", items: [{ label: "调研", desc: "两周" }, { label: "开发" }, { label: "上线" }] },
    ]}, 1);
    for (const t of ["调研", "开发", "上线"]) expect(xml).toContain(t);
  });
  it("keypoints places labels and desc", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "keypoints", title: "亮点", items: [{ label: "快", desc: "毫秒级" }, { label: "省", desc: "低成本" }] },
    ]}, 1);
    expect(xml).toContain("毫秒级");
    expect(xml).toContain("低成本");
  });
  it("quote places text and author", async () => {
    const xml = await slideXml({ title: "", slides: [
      { layout: "quote", title: "", quote: { text: "增长来自复购", author: "CEO" } },
    ]}, 1);
    expect(xml).toContain("增长来自复购");
    expect(xml).toContain("CEO");
  });
  it("agenda auto-generates items from section titles when omitted", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "agenda", title: "目录" },
      { layout: "section", title: "第一章 背景" },
      { layout: "section", title: "第二章 方案" },
    ]}, 1);
    expect(xml).toContain("第一章 背景");
    expect(xml).toContain("第二章 方案");
  });
  it("closing places title and subtitle", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "closing", title: "谢谢观看", subtitle: "欢迎交流" },
    ]}, 1);
    expect(xml).toContain("谢谢观看");
    expect(xml).toContain("欢迎交流");
  });
  it("exports native editable tables and keeps graphic frame IDs unique on the first slide", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "table", title: "明细", table: { columns: ["项目", "状态"], rows: [["门店 A", "已核对"], ["门店 B", ""]] }, source: "店长周报" },
    ] }, 1);
    expect(xml).toContain("<a:tbl>");
    for (const text of ["项目", "状态", "门店 A", "已核对", "门店 B", "店长周报"]) expect(xml).toContain(`<a:t>${text}</a:t>`);
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("keeps a dense native table within a smaller template's canvas", async () => {
    const cell = "已复核\n待确认\n拟提交";
    const theme = { ...DEFAULT_THEME, slideWidthIn: 10, slideHeightIn: 5.625 };
    const zip = await JSZip.loadAsync(await renderPptx({ title: "T", slides: [{
      layout: "table", title: "样例\n逐页验证\n保留数据", table: {
        columns: Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 项`), rows: Array.from({ length: 8 }, () => Array(6).fill(cell)),
      },
    }] }, theme));
    const pptx = await zip.file("ppt/presentation.xml")!.async("string");
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const [, width, height] = pptx.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/)!.map(Number);
    const [, x, y] = xml.match(/<p:xfrm><a:off x="(\d+)" y="(\d+)"/)!.map(Number);
    const columnWidth = [...xml.matchAll(/<a:gridCol w="(\d+)"/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const rowHeight = [...xml.matchAll(/<a:tr h="(\d+)"/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect([width, height]).toEqual([9144000, 5143500]);
    expect(x + columnWidth).toBeLessThan(width);
    expect(y + rowHeight).toBeLessThan(height);
  });
  it("chooses the timeline variant by layout occurrence and numbers section dividers", async () => {
    const timeline = { layout: "timeline" as const, title: "节奏", items: [{ label: "调研" }, { label: "开发" }, { label: "上线" }] };
    const zip = await JSZip.loadAsync(await renderPptx({ title: "T", slides: [
      { layout: "section", title: "第一节" }, timeline, { layout: "section", title: "第二节" }, timeline,
    ] }, DEFAULT_THEME));
    const read = (page: number) => zip.file(`ppt/slides/slide${page}.xml`)!.async("string");
    expect(await read(1)).toContain("<a:t>01</a:t>");
    expect(await read(2)).toContain('prst="ellipse"');
    expect(await read(3)).toContain("<a:t>02</a:t>");
    expect(await read(4)).toContain('prst="chevron"');
  });
});
