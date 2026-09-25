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
it("rejects a scanned/blank-only PDF, protected PDF, invalid UTF-8 and damaged DOCX", async () => {
  async function pdf(options: ConstructorParameters<typeof PDFDocument>[0]) {
    const doc = new PDFDocument(options); const chunks: Buffer[] = [];
    const complete = new Promise<Buffer>((resolve) => { doc.on("data", (b) => chunks.push(b)); doc.on("end", () => resolve(Buffer.concat(chunks))); });
    doc.end(); return complete;
  }
  await expect(parseKnowledge({ mime: "application/pdf", bytes: await pdf({}) })).rejects.toThrow("OCR_REQUIRED");
  await expect(parseKnowledge({ mime: "application/pdf", bytes: await pdf({ userPassword: "fixture-password" }) })).rejects.toThrow(/password/i);
  await expect(parseKnowledge({ mime: "text/plain", bytes: new Uint8Array([255, 255]) })).rejects.toThrow();
  await expect(parseKnowledge({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: Buffer.from("invalid zip") })).rejects.toThrow();
});
it("preserves a DOCX beyond the old attachment cap and enforces extracted output limits", async () => {
  const children = Array.from({ length: 350 }, (_, i) => new Paragraph(`第${i}段：${"全文覆盖".repeat(25)}`));
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  const parsed = await parseKnowledge({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes });
  expect(parsed.blocks.reduce((n, b) => n + b.text.length, 0)).toBeGreaterThan(30000);
  expect(parsed.blocks.at(-1)?.citation).toEqual({ kind: "docx", paragraph: 350 });
  await expect(parseKnowledge({ mime: "text/plain", content: "x".repeat(2_000_001) })).rejects.toThrow("INVALID_TEXT");
});
it("OCRs images and keeps manual descriptions as separate evidence", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const parsed = await parseKnowledge({ mime: "image/png", bytes, description: "人工说明" }, async (image) => {
    expect(image.bytes).toEqual(bytes); return "图片文字";
  });
  expect(parsed.blocks).toEqual([{ text: "图片文字", origin: "ocr" }, { text: "人工说明", origin: "manual_description" }]);
});
it("renders only PDF pages without text and retains page numbers for OCR", async () => {
  const doc = new PDFDocument({ autoFirstPage: false }); const buffers: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => { doc.on("data", (b) => buffers.push(b)); doc.on("end", () => resolve(Buffer.concat(buffers))); });
  doc.addPage().text("TEXT_PAGE"); doc.addPage(); doc.end();
  const parsed = await parseKnowledge({ mime: "application/pdf", bytes: await bytes }, async (image) => {
    expect(image.page).toBe(2); expect(image.mime).toBe("image/png"); expect(image.bytes.length).toBeGreaterThan(0); return "扫描文字";
  });
  expect(parsed.blocks).toEqual([expect.objectContaining({ origin: "extracted_text", citation: { kind: "pdf", page: 1 } }), { text: "扫描文字", origin: "ocr", citation: { kind: "pdf", page: 2 } }]);
  expect(parsed.diagnostics).toEqual([]);
});
it("rejects an empty description instead of publishing an empty index", async () => {
  await expect(parseKnowledge({ mime: "image/png", bytes: new Uint8Array([1]) }, async () => "")).rejects.toThrow("IMAGE_DESCRIPTION_EMPTY");
});
it("describes a text-free image and exposes the description for persistence and retrieval", async () => {
  const modes: Array<string | undefined> = [];
  const parsed = await parseKnowledge({ mime: "image/png", bytes: new Uint8Array([1]) }, async (image) => {
    modes.push(image.mode);
    return image.mode === "describe" ? "白色背景上的蓝色陶瓷杯，杯口朝上，手柄位于右侧。" : "";
  });
  expect(modes).toEqual([undefined, "describe"]);
  expect(parsed.generatedDescription).toBe("白色背景上的蓝色陶瓷杯，杯口朝上，手柄位于右侧。");
  expect(parsed.blocks).toEqual([{ text: parsed.generatedDescription, origin: "generated_description" }]);
});
it("uses an existing description for a text-free image without overwriting it or another model call", async () => {
  let calls = 0;
  const parsed = await parseKnowledge({ mime: "image/png", bytes: new Uint8Array([1]), description: "用户填写的产品说明" }, async () => { calls++; return ""; });
  expect(calls).toBe(1);
  expect(parsed.generatedDescription).toBeUndefined();
  expect(parsed.blocks).toEqual([{ text: "用户填写的产品说明", origin: "manual_description" }]);
});
