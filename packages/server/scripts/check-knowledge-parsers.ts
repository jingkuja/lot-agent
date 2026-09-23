/** Generated, non-sensitive fixtures; checks dependencies, not ingestion readiness. */
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { PDFParse } from "pdf-parse";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import mammoth from "mammoth";

const pdf = new PDFDocument({ autoFirstPage: false });
const chunks: Buffer[] = [];
const complete = new Promise<Buffer>((resolve, reject) => {
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  pdf.on("end", () => resolve(Buffer.concat(chunks)));
  pdf.on("error", reject);
});
for (const marker of ["FIRST_PAGE_MARKER", "SECOND_PAGE_MARKER"]) {
  pdf.addPage().text(marker);
}
pdf.end();
const parser = new PDFParse({ data: new Uint8Array(await complete) });
try {
  const parsed = await parser.getText();
  assert.equal(parsed.pages.length, 2);
  assert.equal(parsed.pages[0].num, 1);
  assert.equal(parsed.pages[1].num, 2);
  assert.ok(parsed.pages[0].text.includes("FIRST_PAGE_MARKER"));
  assert.ok(parsed.pages[1].text.includes("SECOND_PAGE_MARKER"));
  console.log("PDF: 2 real page numbers and markers verified");
} finally {
  await parser.destroy();
}
const paragraphs = Array.from({ length: 500 }, (_, index) => new Paragraph(`段落${index}：` + "中文内容完整提取验证。".repeat(10)));
const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
  new Paragraph({ text: "标题保留", heading: HeadingLevel.HEADING_1 }), ...paragraphs,
] }] }));
const text = await mammoth.extractRawText({ buffer: bytes });
const html = await mammoth.convertToHtml({ buffer: bytes });
assert.ok(text.value.length > 30000);
assert.ok(text.value.includes("段落499："));
assert.ok(html.value.includes("<h1>标题保留</h1>"));
console.log(`DOCX: ${text.value.length} characters, last paragraph and heading preserved`);
console.log("Not validated: scans, complex tables, real-world fixtures, Chinese tokenizer, token limits, resource isolation");
