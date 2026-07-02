import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractTheme, DEFAULT_THEME } from "./theme-extractor.js";

const THEME_XML = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements>
    <a:clrScheme name="Test">
      <a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FEFEFE"/></a:lt1>
      <a:dk2><a:srgbClr val="222222"/></a:dk2>
      <a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:accent1><a:srgbClr val="1F4E79"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
    </a:clrScheme>
    <a:fontScheme name="Test">
      <a:majorFont><a:latin typeface="思源黑体"/></a:majorFont>
      <a:minorFont><a:latin typeface="思源宋体"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;

const PRES_XML = `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`;

async function fixturePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("ppt/theme/theme1.xml", THEME_XML);
  zip.file("ppt/presentation.xml", PRES_XML);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractTheme", () => {
  it("extracts colors, fonts and slide size from a template", async () => {
    const theme = await extractTheme(await fixturePptx());
    expect(theme.colors.dk1).toBe("111111");
    expect(theme.colors.accent1).toBe("1F4E79");
    expect(theme.fonts.major).toBe("思源黑体");
    expect(theme.fonts.minor).toBe("思源宋体");
    expect(theme.slideWidthIn).toBeCloseTo(13.333, 2);
    expect(theme.slideHeightIn).toBeCloseTo(7.5, 2);
  });

  // 降级路径必须返回 DEFAULT_THEME 本体（toBe，同一引用）——
  // generate_ppt 靠引用相等识别静默降级并在结果里注明。
  it("falls back to DEFAULT_THEME (same reference) on a corrupt file", async () => {
    const theme = await extractTheme(Buffer.from("not a zip at all"));
    expect(theme).toBe(DEFAULT_THEME);
  });

  it("falls back to DEFAULT_THEME (same reference) when theme1.xml is missing", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const theme = await extractTheme(await zip.generateAsync({ type: "nodebuffer" }));
    expect(theme).toBe(DEFAULT_THEME);
  });
});
