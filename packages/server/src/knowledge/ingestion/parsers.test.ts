import { expect, it } from "vitest";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import PDFDocument from "pdfkit";
import { parseKnowledge } from "./parsers.js";
it("retains >30K text and labels descriptions separately", async () => {
  const artifact = await parseKnowledge({ mime: "text/plain", content: "说明".repeat(20000) + "END", description: "人工说明" });
  expect(artifact.blocks[0].text).toHaveLength(40003); expect(artifact.blocks[1].origin).toBe("manual_description");
});
it("uses real PDF page numbers and diagnoses blank pages", async () => {
  const doc = new PDFDocument({ autoFirstPage: false }); const buffers: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => { doc.on("data", (value) => buffers.push(value)); doc.on("end", () => resolve(Buffer.concat(buffers))); });
  doc.addPage().text("PAGE_ONE"); doc.addPage(); doc.addPage().text("PAGE_THREE"); doc.end();
  const parsed = await parseKnowledge({ mime: "application/pdf", bytes: await bytes });
  expect(parsed.blocks.map((b) => b.citation)).toEqual([{ kind: "pdf", page: 1 }, { kind: "pdf", page: 3 }]);
  expect(parsed.diagnostics).toContain("OCR_REQUIRED_PAGE_2");
});
it("uses DOCX paragraph/heading locators without fabricated pagination", async () => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: "产品", heading: HeadingLevel.HEADING_1 }), new Paragraph("型号 AB-123"), new Paragraph("末段内容")] }] }));
  const parsed = await parseKnowledge({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes });
  expect(parsed.blocks.at(-1)).toMatchObject({ text: "末段内容", citation: { kind: "docx", paragraph: 3, heading: "产品" } });
});
it("does not pretend to understand media without a user description", async () => {
  await expect(parseKnowledge({ mime: "image/png" })).rejects.toThrow("DESCRIPTION_REQUIRED");
  expect((await parseKnowledge({ mime: "image/png", description: "说明" })).blocks[0].origin).toBe("manual_description");
});
