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
});
