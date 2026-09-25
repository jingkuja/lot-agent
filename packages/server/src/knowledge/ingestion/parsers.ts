import type { RecognizeImage } from "./ocr.js";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { MAX_EXTRACTED_CHARACTERS, textBlocks, type ParsedBlock } from "./text.js";

export interface ParseInput { mime: string; bytes?: Uint8Array; content?: string; description?: string }
export interface ParsedArtifact { blocks: ParsedBlock[]; diagnostics: string[]; parserVersion: string; generatedDescription?: string }
import { PARSER_VERSION } from "./version.js";
export { PARSER_VERSION } from "./version.js";

/** Runs inside a resource-limited worker, never on the HTTP event loop. */
export async function parseKnowledge(input: ParseInput, ocr?: RecognizeImage): Promise<ParsedArtifact> {
  const blocks: ParsedBlock[] = []; const diagnostics: string[] = [];
  let extracted = 0; let generatedDescription: string | undefined;
  const add = (block: ParsedBlock) => {
    extracted += block.text.length;
    if (extracted > MAX_EXTRACTED_CHARACTERS) throw new Error("TEXT_LIMIT_EXCEEDED");
    if (block.text.trim()) blocks.push(block);
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
      if (ocr && parsed.pages.filter((page) => !page.text.trim()).length > 50) throw new Error("OCR_PAGE_LIMIT_EXCEEDED");
      for (const page of parsed.pages) {
        if (page.text.trim()) {
          add({ text: page.text, origin: "extracted_text", citation: { kind: "pdf", page: page.num } });
        } else if (ocr) {
          // Render one page at a time to bound memory; preserve the actual PDF locator.
          const rendered = await parser.getScreenshot({ partial: [page.num], desiredWidth: 1800, imageDataUrl: false, imageBuffer: true });
          const image = rendered.pages[0];
          if (!image) throw new Error("OCR_RENDER_FAILED");
          const text = await ocr({ mime: "image/png", bytes: image.data, page: page.num });
          add({ text, origin: "ocr", citation: { kind: "pdf", page: page.num } });
          if (!text.trim()) diagnostics.push(`OCR_EMPTY_PAGE_${page.num}`);
        } else diagnostics.push(`OCR_REQUIRED_PAGE_${page.num}`);
      }
      if (!blocks.length) throw new Error(ocr ? "OCR_EMPTY_TEXT" : "OCR_REQUIRED");
    } finally { await parser.destroy(); }
  } else if (input.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
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
    if (!blocks.length) throw new Error("EMPTY_TEXT");
  } else if (input.mime.startsWith("image/") && ocr) {
    if (!input.bytes) throw new Error("DOCUMENT_MISSING");
    add({ text: await ocr({ mime: input.mime, bytes: input.bytes }), origin: "ocr" });
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
  if (!blocks.length) throw new Error("DESCRIPTION_REQUIRED");
  const length = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (length > MAX_EXTRACTED_CHARACTERS) throw new Error("TEXT_LIMIT_EXCEEDED");
  if (blocks.some((block) => block.text.includes("\u0000") || block.text.includes("\ufffd"))) throw new Error("INVALID_TEXT");
  return { blocks, diagnostics, parserVersion: PARSER_VERSION, ...(generatedDescription ? { generatedDescription } : {}) };
}
