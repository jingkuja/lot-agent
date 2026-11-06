import type { RecognizeImage } from "./ocr.js";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { EXCEL_MIMES, PPTX_MIME, embeddedImages, excelToText, pptxToText } from "./office-text.js";
import { MAX_EXTRACTED_CHARACTERS, textBlocks, type ParsedBlock } from "./text.js";

export interface ParseInput {
  mime: string;
  bytes?: Uint8Array;
  content?: string;
  description?: string;
  /** Also read pictures inside documents, up to this many per file. The knowledge base leaves it off. */
  readImages?: { maxImages: number };
}
export interface ParsedArtifact { blocks: ParsedBlock[]; diagnostics: string[]; parserVersion: string; generatedDescription?: string }
import { PARSER_VERSION } from "./version.js";
export { PARSER_VERSION } from "./version.js";

/** Below this a picture is an icon or a bullet. */
const PICTURE_MIN_PIXELS = 200;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function compact(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** A rendered page repeats its text layer. Only what the layer lacks came from a picture. */
export function textOnlyInImage(recognized: string, pageText: string): string {
  const known = compact(pageText);
  return recognized.split("\n").filter((line) => {
    const key = compact(line);
    return key && !known.includes(key);
  }).join("\n");
}

/** Runs inside a resource-limited worker, never on the HTTP event loop. */
export async function parseKnowledge(input: ParseInput, ocr?: RecognizeImage): Promise<ParsedArtifact> {
  const blocks: ParsedBlock[] = []; const diagnostics: string[] = [];
  let extracted = 0; let generatedDescription: string | undefined;
  const add = (block: ParsedBlock) => {
    extracted += block.text.length;
    if (extracted > MAX_EXTRACTED_CHARACTERS) throw new Error("TEXT_LIMIT_EXCEEDED");
    if (block.text.trim()) blocks.push(block);
  };
  const readEmbedded = async (bytes: Uint8Array) => {
    if (!ocr || !input.readImages) return;
    const images = await embeddedImages(Buffer.from(bytes));
    for (const [index, image] of images.entries()) {
      if (index >= input.readImages.maxImages) { diagnostics.push(`OCR_REQUIRED_PAGE_image_${index + 1}`); continue; }
      const text = await ocr({ mime: image.mime, bytes: image.bytes });
      if (text.trim()) add({ text: image.label ? `${image.label}\n${text}` : text, origin: "ocr" });
    }
  };
  if ((input.bytes?.byteLength ?? 0) > 50 * 1024 * 1024) throw new Error("DOCUMENT_TOO_LARGE");
  if (input.mime === "text/plain" || input.mime === "text/markdown") {
    const text = input.content ?? new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    blocks.push(...textBlocks(text));
  } else if (input.mime === "application/pdf") {
    if (!input.bytes) throw new Error("DOCUMENT_MISSING");
    const parser = new PDFParse({ data: input.bytes });
    try {
      const info = await parser.getInfo();
      if (info.total > 500) throw new Error("TOO_MANY_PAGES");
      const parsed = await parser.getText();
      const blankPages = parsed.pages.filter((page) => !page.text.trim()).length;
      const limit = input.readImages?.maxImages;
      if (ocr && limit === undefined && blankPages > 50) throw new Error("OCR_PAGE_LIMIT_EXCEEDED");
      // Scanned pages have nothing else, so mixed pages only get what they leave.
      let scansLeft = limit ?? Number.POSITIVE_INFINITY;
      let mixedLeft = limit === undefined ? 0 : Math.max(0, limit - blankPages);
      // Render one page at a time to bound memory; preserve the actual PDF locator.
      const readPage = async (num: number) => {
        const rendered = await parser.getScreenshot({ partial: [num], desiredWidth: 1800, imageDataUrl: false, imageBuffer: true });
        const image = rendered.pages[0];
        if (!image) throw new Error("OCR_RENDER_FAILED");
        return ocr!({ mime: "image/png", bytes: image.data, page: num });
      };
      const hasPicture = async (num: number) => {
        const found = await parser.getImage({ partial: [num], imageThreshold: PICTURE_MIN_PIXELS, imageBuffer: false, imageDataUrl: false });
        return (found.pages[0]?.images.length ?? 0) > 0;
      };
      for (const page of parsed.pages) {
        const citation = { kind: "pdf" as const, page: page.num };
        if (page.text.trim()) {
          add({ text: page.text, origin: "extracted_text", citation });
          if (!ocr || mixedLeft <= 0 || !await hasPicture(page.num)) continue;
          mixedLeft -= 1;
          add({ text: textOnlyInImage(await readPage(page.num), page.text), origin: "ocr", citation });
        } else if (ocr && scansLeft > 0) {
          scansLeft -= 1;
          const text = await readPage(page.num);
          add({ text, origin: "ocr", citation });
          if (!text.trim()) diagnostics.push(`OCR_EMPTY_PAGE_${page.num}`);
        } else diagnostics.push(`OCR_REQUIRED_PAGE_${page.num}`);
      }
      if (!blocks.length) throw new Error(ocr ? "OCR_EMPTY_TEXT" : "OCR_REQUIRED");
    } finally { await parser.destroy(); }
  } else if (input.mime === DOCX_MIME) {
    if (!input.bytes) throw new Error("DOCUMENT_MISSING");
    let paragraph = 0; let heading: string | undefined;
    type Element = { type?: string; value?: string; styleName?: string; styleId?: string; children?: Element[] };
    const text = (node: Element): string => node.type === "text" ? node.value ?? "" : node.type === "tab" ? "\t" : node.type === "break" ? "\n" : (node.children ?? []).map(text).join("");
    const visit = (node: Element) => {
      if (node.type === "paragraph") {
        paragraph++; const value = text(node);
        if (/^heading\s*\d/i.test(node.styleName ?? node.styleId ?? "")) heading = value;
        add({ text: value, origin: "extracted_text", citation: { kind: "docx", paragraph, ...(heading ? { heading } : {}) } });
      } else for (const child of node.children ?? []) visit(child);
    };
    await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) }, { transformDocument(document: Element) { visit(document); return document; } });
    await readEmbedded(input.bytes);
    if (!blocks.length) throw new Error("EMPTY_TEXT");
  } else if (input.mime === PPTX_MIME || EXCEL_MIMES.has(input.mime)) {
    if (!input.bytes) throw new Error("DOCUMENT_MISSING");
    const bytes = Buffer.from(input.bytes);
    blocks.push(...textBlocks(input.mime === PPTX_MIME ? await pptxToText(bytes) : excelToText(bytes)));
    await readEmbedded(input.bytes);
  } else if (input.mime.startsWith("image/") && ocr) {
    if (!input.bytes) throw new Error("DOCUMENT_MISSING");
    add({ text: await ocr({ mime: input.mime, bytes: input.bytes }), origin: "ocr" });
    if (!blocks.length && input.readImages) throw new Error("EMPTY_TEXT");
    if (!blocks.length && !input.description?.trim()) {
      generatedDescription = (await ocr({ mime: input.mime, bytes: input.bytes, mode: "describe" })).trim();
      if (!generatedDescription || generatedDescription === "<NO_TEXT>") throw new Error("IMAGE_DESCRIPTION_EMPTY");
      if (generatedDescription.length > 5000) throw new Error("IMAGE_DESCRIPTION_TOO_LONG");
      add({ text: generatedDescription, origin: "generated_description" });
    }
  } else if (!/^(image|audio|video)\//.test(input.mime) && input.mime !== "bookmark") {
    throw new Error("UNSUPPORTED_DOCUMENT");
  }
  if (input.description?.trim()) add({ text: input.description, origin: "manual_description" });
  if (!blocks.length) throw new Error(input.readImages ? "EMPTY_TEXT" : "DESCRIPTION_REQUIRED");
  const length = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (length > MAX_EXTRACTED_CHARACTERS) throw new Error("TEXT_LIMIT_EXCEEDED");
  if (blocks.some((block) => block.text.includes("\u0000") || block.text.includes("\ufffd"))) throw new Error("INVALID_TEXT");
  return { blocks, diagnostics, parserVersion: PARSER_VERSION, ...(generatedDescription ? { generatedDescription } : {}) };
}
