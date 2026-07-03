import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildTemplatePptx } from "./template-renderer.fixture.js";
import {
  renderPptxFromTemplate,
  templateHasReusableDesign,
} from "./template-renderer.js";
import type { PptOutline } from "./renderer.js";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/**
 * "空白版式型"模版：母版背景是纯白 bg1、版式只有占位符没有任何设计——
 * 设计都画在每页幻灯片上（这里省略）。克隆它只会得到白板，应判为"不值得克隆"。
 */
async function buildBlankLayoutTemplate(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`
  );
  // 母版背景 = schemeClr bg1（纯白），无背景图/形状
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree/></p:cSld></p:sldMaster>`
  );
  // 版式：title + obj，均无背景、无形状、无图片
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0"?><p:sldLayout ${NS} type="title"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`
  );
  zip.file(
    "ppt/slideLayouts/slideLayout2.xml",
    `<?xml version="1.0"?><p:sldLayout ${NS} type="obj"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const outline: PptOutline = {
  title: "季度汇报",
  slides: [
    { layout: "cover", title: "季度汇报", bullets: ["2026 Q2"] },
    { layout: "section", title: "业务回顾" },
    { layout: "content", title: "关键指标 & 进展", bullets: ["营收 +18%", "留存 <92%>"] },
  ],
};

describe("renderPptxFromTemplate", () => {
  it("replaces template slides with outline slides wired to the template's own layouts", async () => {
    const out = await renderPptxFromTemplate(outline, await buildTemplatePptx());
    const zip = await JSZip.loadAsync(out);

    // 3 张新幻灯片
    const s1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const s2 = await zip.file("ppt/slides/slide2.xml")!.async("string");
    const s3 = await zip.file("ppt/slides/slide3.xml")!.async("string");
    expect(zip.file("ppt/slides/slide4.xml")).toBeNull();

    // 旧内容没了，新标题在
    expect(s1).not.toContain("OLD-SLIDE-TEXT");
    expect(s1).toContain("<a:t>季度汇报</a:t>");
    expect(s1).toContain("<a:t>2026 Q2</a:t>"); // cover 副标题
    expect(s2).toContain("<a:t>业务回顾</a:t>");
    expect(s3).toContain("<a:t>营收 +18%</a:t>");
    // XML 特殊字符要转义
    expect(s3).toContain("留存 &lt;92%&gt;");
    expect(s3).toContain("关键指标 &amp; 进展");

    // 占位符沿用布局定义：cover 用 ctrTitle，content 正文用 idx="1"
    expect(s1).toContain('type="ctrTitle"');
    expect(s3).toContain('idx="1"');

    // rels：cover → layout1，content → layout2
    const r1 = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
    const r3 = await zip.file("ppt/slides/_rels/slide3.xml.rels")!.async("string");
    expect(r1).toContain("slideLayout1.xml");
    expect(r3).toContain("slideLayout2.xml");

    // 模版资产原样保留（背景图、母版、布局、主题）
    expect(zip.file("ppt/media/image1.png")).not.toBeNull();
    expect(zip.file("ppt/slideMasters/slideMaster1.xml")).not.toBeNull();
    expect(zip.file("ppt/theme/theme1.xml")).not.toBeNull();

    // 装配面：Content_Types、presentation.xml、presentation rels 一致
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    expect(ct.match(/slides\/slide\d+\.xml/g)?.length).toBe(3);
    const pres = await zip.file("ppt/presentation.xml")!.async("string");
    expect(pres.match(/<p:sldId /g)?.length).toBe(3);
    const prels = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
    expect(prels.match(/relationships\/slide"/g)?.length).toBe(3);
    // 每个 sldId 的 r:id 都能在 rels 里找到
    for (const m of pres.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)) {
      expect(prels).toContain(`Id="${m[1]}"`);
    }
  });

  it("throws on a template without presentation.xml so callers can fall back", async () => {
    const zip = new JSZip();
    zip.file("ppt/theme/theme1.xml", "<a:theme/>");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await expect(renderPptxFromTemplate(outline, bytes)).rejects.toThrow();
  });

  it("throws on non-zip bytes", async () => {
    await expect(
      renderPptxFromTemplate(outline, Buffer.from("definitely not a pptx"))
    ).rejects.toThrow();
  });

  it("sets explicit legible font sizes on inserted text so it doesn't inherit the master's oversized defaults", async () => {
    const out = await renderPptxFromTemplate(outline, await buildTemplatePptx());
    const zip = await JSZip.loadAsync(out);
    const cover = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const content = await zip.file("ppt/slides/slide3.xml")!.async("string");
    // 封面标题、正文标题、正文项都带显式字号（百分点单位）
    expect(cover).toMatch(/<a:rPr[^>]*\bsz="3200"/); // cover 标题 32pt
    expect(content).toMatch(/<a:rPr[^>]*\bsz="2600"/); // content 标题 26pt
    expect(content).toMatch(/<a:rPr[^>]*\bsz="1800"/); // 正文 18pt
  });
});

describe("templateHasReusableDesign", () => {
  it("returns true for a template whose master carries a background image", async () => {
    expect(await templateHasReusableDesign(await buildTemplatePptx())).toBe(true);
  });

  it("returns false for a blank-layout template (design lives per-slide, cloning yields a white board)", async () => {
    expect(await templateHasReusableDesign(await buildBlankLayoutTemplate())).toBe(
      false
    );
  });

  it("throws on non-zip bytes so callers can report a parse failure", async () => {
    await expect(
      templateHasReusableDesign(Buffer.from("definitely not a pptx"))
    ).rejects.toThrow();
  });
});
