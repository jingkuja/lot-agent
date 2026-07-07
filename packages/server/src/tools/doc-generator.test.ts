import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { generateDocument } from "./doc-generator.js";

const here = dirname(fileURLToPath(import.meta.url));
// packages/server/src/tools → project root
const FONT = resolve(here, "../../../..", "assets/fonts/NotoSansSC-Regular.otf");

/** 覆盖此前"原样漏出"的全部 markdown 语法。 */
const RICH_MD = [
  "# 一级标题",
  "",
  "正文段落，含 **加粗文字** 和 *斜体* 与 `行内代码`，以及[链接](https://example.com)。",
  "",
  "#### 四级标题",
  "",
  "1. 第一项",
  "2. 第二项",
  "",
  "- 无序甲",
  "- 无序乙",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 单元格1 | 单元格2 |",
  "",
  "> 引用的一句话",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  "---",
  "",
  "结尾段落。",
].join("\n");

/** 这些原始 markdown 记号绝不能出现在导出的文本里。 */
const RAW_MARKERS = ["**", "```", "####", "| ---", "- 无序甲"];

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

describe("generateDocument · md", () => {
  it("writes Markdown with the title as a top heading", async () => {
    const { buffer, format } = await generateDocument({
      title: "报告",
      content: "正文内容",
      format: "md",
    });
    expect(format).toBe("md");
    expect(buffer.toString("utf8")).toBe("# 报告\n\n正文内容\n");
  });
});

describe("generateDocument · html", () => {
  it("renders the full markdown feature set as real HTML", async () => {
    const { buffer, format } = await generateDocument({
      title: "T",
      content: RICH_MD,
      format: "html",
    });
    expect(format).toBe("html");
    const html = buffer.toString("utf8");
    expect(html).toContain("<h1");
    expect(html).toContain("<h4");
    expect(html).toContain("<strong>加粗文字</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>单元格1</td>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("const answer = 42;");
    expect(html).toContain('href="https://example.com"');
  });

  it("escapes raw HTML in the source", async () => {
    const { buffer } = await generateDocument({
      title: "",
      content: "para <script>alert(1)</script>",
      format: "html",
    });
    expect(buffer.toString("utf8")).not.toContain("<script>alert");
  });
});

describe("generateDocument · docx", () => {
  it("writes a valid .docx and converts markdown instead of leaking it", async () => {
    const { buffer, format } = await generateDocument({
      title: "标题",
      content: RICH_MD,
      format: "docx",
    });
    expect(format).toBe("docx");
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const text = (await mammoth.extractRawText({ buffer })).value;
    // 内容都在
    for (const s of ["一级标题", "加粗文字", "四级标题", "第一项", "无序甲", "单元格1", "单元格2", "引用的一句话", "const answer = 42;", "结尾段落"]) {
      expect(text).toContain(s);
    }
    // 原始 markdown 记号不能漏出
    for (const marker of RAW_MARKERS) {
      expect(text).not.toContain(marker);
    }
  });

  it("emits real bold runs for **bold** text", async () => {
    const { buffer } = await generateDocument({
      title: "",
      content: "有 **重点** 的段落",
      format: "docx",
    });
    const html = (await mammoth.convertToHtml({ buffer })).value;
    expect(html).toContain("<strong>重点</strong>");
  });

  it("emits a real table for markdown tables", async () => {
    const { buffer } = await generateDocument({
      title: "",
      content: "| A | B |\n| --- | --- |\n| 1 | 2 |",
      format: "docx",
    });
    const html = (await mammoth.convertToHtml({ buffer })).value;
    expect(html).toContain("<table>");
    expect(html).toContain("<td><p>1</p></td>");
  });
});

describe("generateDocument · pdf", () => {
  it("writes a valid .pdf whose text has markdown converted, not leaked", async () => {
    const { buffer, format } = await generateDocument({
      title: "中文标题",
      content: RICH_MD,
      format: "pdf",
      fontPath: FONT,
    });
    expect(format).toBe("pdf");
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");

    const text = await pdfText(buffer);
    for (const s of ["一级标题", "加粗文字", "四级标题", "第一项", "单元格1", "单元格2", "引用的一句话", "结尾段落"]) {
      expect(text).toContain(s);
    }
    for (const marker of RAW_MARKERS) {
      expect(text).not.toContain(marker);
    }
  });

  it("does not emit blank trailing pages (footer must not overflow the page)", async () => {
    // Content that fills a couple of pages; regression for the footer write
    // pushing PDFKit past the bottom margin and appending a blank page each time.
    const body: string[] = ["# 报告"];
    for (let s = 1; s <= 6; s++) {
      body.push(`## 第${s}节`);
      body.push("正文段落，用于填充内容。".repeat(6));
      body.push("- 要点一", "- 要点二", "- 要点三");
    }
    const { buffer } = await generateDocument({
      title: "标题",
      content: body.join("\n\n"),
      format: "pdf",
      fontPath: FONT,
    });

    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const parsed = await parser.getText();
      const pages = parsed.pages ?? [];
      // A blank page is one whose only text is the "n / m" footer.
      const blanks = pages.filter((p: { text?: string }) =>
        /^\d+\s*\/\s*\d+$/.test((p.text ?? "").replace(/\s+/g, " ").trim())
      );
      expect(blanks.length).toBe(0);
    } finally {
      await parser.destroy();
    }
  });

  it("degrades pdf to markdown when no font is provided", async () => {
    const { buffer, format } = await generateDocument({
      title: "T",
      content: "body",
      format: "pdf",
    });
    expect(format).toBe("md");
    expect(buffer.toString("utf8")).toBe("# T\n\nbody\n");
  });
});

describe("generateDocument · accent styling", () => {
  it("applies a custom accent color to docx headings", async () => {
    const { buffer } = await generateDocument({
      title: "",
      content: "# 标题",
      format: "docx",
      accentColor: "8E44AD",
    });
    // heading color lands in word/document.xml or styles.xml
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const styles = await zip.file("word/styles.xml")!.async("string");
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(styles + docXml).toContain("8E44AD");
  });

  it("rejects garbage accent colors silently (falls back to default)", async () => {
    const { buffer, format } = await generateDocument({
      title: "",
      content: "# 标题",
      format: "docx",
      accentColor: "not-a-color",
    });
    expect(format).toBe("docx");
    expect(buffer.length).toBeGreaterThan(1000);
  });
});
