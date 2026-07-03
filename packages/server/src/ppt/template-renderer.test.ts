import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildTemplatePptx } from "./template-renderer.fixture.js";
import { renderPptxFromTemplate } from "./template-renderer.js";
import type { PptOutline } from "./renderer.js";

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
});
