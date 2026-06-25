import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseBlocks, inlinePlain, generateDocument } from "./doc-generator.js";

const here = dirname(fileURLToPath(import.meta.url));
// packages/server/src/tools → project root
const FONT = resolve(here, "../../../..", "assets/fonts/NotoSansSC-Regular.otf");

describe("parseBlocks", () => {
  it("classifies headings, bullets, paragraphs and blanks", () => {
    const blocks = parseBlocks("# Title\n\n- one\n* two\npara text");
    expect(blocks).toEqual([
      { kind: "h1", text: "Title" },
      { kind: "blank", text: "" },
      { kind: "bullet", text: "one" },
      { kind: "bullet", text: "two" },
      { kind: "para", text: "para text" },
    ]);
  });

  it("supports ## and ### heading levels", () => {
    expect(parseBlocks("## H2")[0]).toEqual({ kind: "h2", text: "H2" });
    expect(parseBlocks("### H3")[0]).toEqual({ kind: "h3", text: "H3" });
  });
});

describe("inlinePlain", () => {
  it("strips bold, italic and inline code markup", () => {
    expect(inlinePlain("**bold** and *italic* and `code`")).toBe(
      "bold and italic and code"
    );
  });
});

describe("generateDocument", () => {
  it("writes Markdown with the title as a top heading", async () => {
    const { buffer, format } = await generateDocument({
      title: "报告",
      content: "正文内容",
      format: "md",
    });
    expect(format).toBe("md");
    expect(buffer.toString("utf8")).toBe("# 报告\n\n正文内容\n");
  });

  it("writes HTML with headings, lists and escaped content", async () => {
    const { buffer, format } = await generateDocument({
      title: "T",
      content: "## Sub\n- item <x>\npara",
      format: "html",
    });
    expect(format).toBe("html");
    const html = buffer.toString("utf8");
    expect(html).toContain("<h1>T</h1>");
    expect(html).toContain("<h2>Sub</h2>");
    expect(html).toContain("<li>item &lt;x&gt;</li>");
    expect(html).toContain("<p>para</p>");
  });

  it("writes a valid .docx (zip) buffer", async () => {
    const { buffer, format } = await generateDocument({
      title: "标题",
      content: "# 段落\n- 项目",
      format: "docx",
    });
    expect(format).toBe("docx");
    // docx is a zip — starts with the "PK\x03\x04" local file header.
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("writes a valid .pdf buffer with an embedded CJK font", async () => {
    const { buffer, format } = await generateDocument({
      title: "中文标题",
      content: "# 章节\n- 要点\n正文 paragraph",
      format: "pdf",
      fontPath: FONT,
    });
    expect(format).toBe("pdf");
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
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
