import { crc32, deflateSync } from "node:zlib";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph } from "docx";
import { describe, expect, it, vi } from "vitest";
import type { OcrImage } from "./ocr.js";
import { embeddedImages, imageSize } from "./office-text.js";
import { parseKnowledge, textOnlyInImage } from "./parsers.js";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG with a colour derived from `seed`, so two pictures of one size hash differently. */
function png(width: number, height: number, seed = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, seed);
  row[0] = 0;
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pdf(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const parts: Buffer[] = [];
  return new Promise((resolve) => {
    doc.on("data", (part) => parts.push(part));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    build(doc);
    doc.end();
  });
}

async function pptx(slides: Array<{ text: string; images: Record<string, Buffer> }>): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((slide, index) => {
    const number = index + 1;
    zip.file(`ppt/slides/slide${number}.xml`, `<p:sld><a:t>${slide.text}</a:t></p:sld>`);
    const rels = Object.keys(slide.images).map((name) => `<Relationship Target="../media/${name}"/>`).join("");
    zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, `<Relationships>${rels}</Relationships>`);
    for (const [name, data] of Object.entries(slide.images)) zip.file(`ppt/media/${name}`, data);
  });
  return zip.generateAsync({ type: "nodebuffer" });
}

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("textOnlyInImage", () => {
  it("keeps only what the page's text layer lacks", () => {
    const recognized = "价格与型号\n| 型号 | 售价 |\n|---|---|\n| A3 | 1,299 元 |";
    expect(textOnlyInImage(recognized, "价格与型号\n具体见下图")).toBe("| 型号 | 售价 |\n| A3 | 1,299 元 |");
  });

  it("ignores differences in spacing and width", () => {
    expect(textOnlyInImage("周卡５餐 138 元", "周卡 5 餐 138元")).toBe("");
  });
});

describe("PDF pictures", () => {
  const mixed = () => pdf((doc) => {
    doc.addPage().text("INTRO_PAGE");
    doc.addPage().text("PRICES_BELOW").image(png(400, 300), 50, 120, { width: 400 });
    doc.addPage().text("ICON_ONLY").image(png(48, 48), 50, 120, { width: 48 });
    doc.addPage();
  });

  it("reads pages that hold a picture beside their text, and skips icons", async () => {
    const pages: Array<number | undefined> = [];
    const parsed = await parseKnowledge({ mime: "application/pdf", bytes: await mixed(), readImages: { maxImages: 50 } }, async (image) => {
      pages.push(image.page);
      return image.page === 2 ? "PRICES_BELOW\nA3 1299 元" : "扫描页";
    });
    expect(pages).toEqual([2, 4]);
    expect(parsed.blocks.filter((block) => block.origin === "ocr")).toEqual([
      { text: "A3 1299 元", origin: "ocr", citation: { kind: "pdf", page: 2 } },
      { text: "扫描页", origin: "ocr", citation: { kind: "pdf", page: 4 } },
    ]);
  });

  it("leaves the knowledge base's behaviour alone without the option", async () => {
    const pages: Array<number | undefined> = [];
    await parseKnowledge({ mime: "application/pdf", bytes: await mixed() }, async (image) => { pages.push(image.page); return "文字"; });
    expect(pages).toEqual([4]);
  });

  it("spends the limit on scanned pages first and reports the rest instead of failing", async () => {
    const bytes = await pdf((doc) => {
      doc.addPage().text("HAS_TEXT").image(png(400, 300), 50, 120, { width: 400 });
      doc.addPage(); doc.addPage(); doc.addPage();
    });
    const ocr = vi.fn(async (_image: OcrImage) => "文字");
    const parsed = await parseKnowledge({ mime: "application/pdf", bytes, readImages: { maxImages: 2 } }, ocr);
    expect(ocr.mock.calls.map(([image]) => image.page)).toEqual([2, 3]);
    expect(parsed.diagnostics).toEqual(["OCR_REQUIRED_PAGE_4"]);
  });

  it("still reads a long scan when the limit is reached rather than rejecting it", async () => {
    const bytes = await pdf((doc) => { for (let index = 0; index < 3; index += 1) doc.addPage(); });
    const parsed = await parseKnowledge({ mime: "application/pdf", bytes, readImages: { maxImages: 1 } }, async () => "第一页");
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.diagnostics).toEqual(["OCR_REQUIRED_PAGE_2", "OCR_REQUIRED_PAGE_3"]);
  });
});

describe("pictures inside Office files", () => {
  it("reads sizes from PNG and JPEG headers", () => {
    expect(imageSize(png(320, 240))).toEqual({ width: 320, height: 240 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 3, 1, 0x22]);
    expect(imageSize(jpeg)).toEqual({ width: 600, height: 300 });
    expect(imageSize(Buffer.from("not an image at all"))).toBeNull();
  });

  it("drops icons, banners, repeats and template pictures, and keeps slide order", async () => {
    const logo = png(600, 400, 1);
    const bytes = await pptx([
      { text: "一", images: { "logo.png": logo, "icon.png": png(64, 64, 2) } },
      { text: "二", images: { "logo.png": logo, "image10.png": png(500, 400, 3), "banner.png": png(1600, 100, 4) } },
      { text: "三", images: { "logo.png": logo, "image2.png": png(500, 400, 5), "copy.png": png(500, 400, 3) } },
    ]);
    expect((await embeddedImages(bytes)).map((image) => image.label)).toEqual(["Slide 2", "Slide 3"]);
  });

  it("returns nothing for a file that is not a zip", async () => {
    expect(await embeddedImages(Buffer.from("legacy xls"))).toEqual([]);
  });

  it("adds a slide's picture text after the slide text", async () => {
    const bytes = await pptx([{ text: "菜单见图", images: { "menu.png": png(500, 400) } }]);
    const parsed = await parseKnowledge({ mime: PPTX, bytes, readImages: { maxImages: 5 } }, async () => "酸辣米线 15");
    expect(parsed.blocks.at(-1)).toEqual({ text: "Slide 1\n酸辣米线 15", origin: "ocr" });
  });

  it("reads a Word file that is only pictures", async () => {
    const zip = await JSZip.loadAsync(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("")] }] })));
    zip.file("word/media/image1.png", png(500, 400));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const parsed = await parseKnowledge({ mime: DOCX, bytes, readImages: { maxImages: 5 } }, async () => "滤芯 268 元");
    expect(parsed.blocks).toEqual([{ text: "滤芯 268 元", origin: "ocr" }]);
    await expect(parseKnowledge({ mime: DOCX, bytes })).rejects.toThrow("EMPTY_TEXT");
  });

  it("counts pictures past the limit as unread", async () => {
    const bytes = await pptx([{ text: "图", images: { "a.png": png(500, 400, 1), "b.png": png(500, 400, 2) } }]);
    const parsed = await parseKnowledge({ mime: PPTX, bytes, readImages: { maxImages: 1 } }, async () => "一张");
    expect(parsed.diagnostics).toEqual(["OCR_REQUIRED_PAGE_image_2"]);
  });
});

describe("a photo", () => {
  it("does not make up a description when it holds no text", async () => {
    const ocr = vi.fn(async () => "");
    await expect(parseKnowledge({ mime: "image/png", bytes: png(300, 300), readImages: { maxImages: 5 } }, ocr)).rejects.toThrow("EMPTY_TEXT");
    expect(ocr).toHaveBeenCalledOnce();
  });
});
