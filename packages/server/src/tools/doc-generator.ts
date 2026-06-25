import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
} from "docx";
import PDFDocument from "pdfkit";

/**
 * Pure-TS document generator — turns Markdown content into a downloadable
 * document buffer (Word / PDF / Markdown / HTML). Replaces the former
 * `gen_doc.py` Python script so the server needs no Python runtime/venv.
 * Mirrors the tiny markdown subset the Python script supported.
 */

export type DocFormat = "docx" | "pdf" | "md" | "html";

export type BlockKind = "h1" | "h2" | "h3" | "bullet" | "para" | "blank";
export interface DocBlock {
  kind: BlockKind;
  text: string;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;

/** Split content into (kind, text) blocks: headings / bullets / paragraphs / blanks. */
export function parseBlocks(content: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blocks.push({ kind: "blank", text: "" });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ kind: ("h" + h[1].length) as BlockKind, text: h[2].trim() });
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b) {
      blocks.push({ kind: "bullet", text: b[1].trim() });
      continue;
    }
    blocks.push({ kind: "para", text: line.trim() });
  }
  return blocks;
}

/** Strip basic inline markdown (**bold**, *italic*, `code`) to plain text. */
export function inlinePlain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── writers ──────────────────────────────────────────────────────────────────

function writeMd(title: string, content: string): Buffer {
  let out = "";
  if (title) out += `# ${title}\n\n`;
  out += content;
  if (!out.endsWith("\n")) out += "\n";
  return Buffer.from(out, "utf8");
}

function writeHtml(title: string, content: string): Buffer {
  const parts = [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title || "Document")}</title>`,
    "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;" +
      "max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;" +
      "color:#1a1a22}h1,h2,h3{line-height:1.3}code{background:#f3f3f7;" +
      "padding:2px 5px;border-radius:4px}</style></head><body>",
  ];
  if (title) parts.push(`<h1>${escapeHtml(title)}</h1>`);
  let inList = false;
  for (const { kind, text } of parseBlocks(content)) {
    const esc = escapeHtml(inlinePlain(text));
    if (kind === "bullet") {
      if (!inList) {
        parts.push("<ul>");
        inList = true;
      }
      parts.push(`<li>${esc}</li>`);
      continue;
    }
    if (inList) {
      parts.push("</ul>");
      inList = false;
    }
    if (kind === "h1" || kind === "h2" || kind === "h3") {
      parts.push(`<${kind}>${esc}</${kind}>`);
    } else if (kind === "para") {
      parts.push(`<p>${esc}</p>`);
    }
  }
  if (inList) parts.push("</ul>");
  parts.push("</body></html>");
  return Buffer.from(parts.join("\n"), "utf8");
}

const DOCX_HEADING: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
};

async function writeDocx(title: string, content: string): Promise<Buffer> {
  const children: Paragraph[] = [];
  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  }
  for (const { kind, text } of parseBlocks(content)) {
    const plain = inlinePlain(text);
    if (kind === "blank") continue;
    if (kind === "bullet") {
      children.push(new Paragraph({ text: plain, bullet: { level: 0 } }));
    } else if (kind === "h1" || kind === "h2" || kind === "h3") {
      children.push(new Paragraph({ text: plain, heading: DOCX_HEADING[kind] }));
    } else {
      children.push(new Paragraph({ children: [new TextRun(plain)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function writePdf(title: string, content: string, fontPath: string): Promise<Buffer> {
  return new Promise((res, rej) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => res(Buffer.concat(chunks)));
    doc.on("error", rej);

    // Single CJK font for the whole document (no separate bold face) — heading
    // sizes provide the visual hierarchy. Without this, Chinese renders blank.
    doc.registerFont("body", fontPath);
    doc.font("body");

    if (title) {
      doc.fontSize(22).text(title);
      doc.moveDown(0.6);
    }
    for (const { kind, text } of parseBlocks(content)) {
      const plain = inlinePlain(text);
      if (kind === "blank") {
        doc.moveDown(0.4);
      } else if (kind === "h1") {
        doc.fontSize(18).text(plain);
        doc.moveDown(0.2);
      } else if (kind === "h2") {
        doc.fontSize(15).text(plain);
        doc.moveDown(0.2);
      } else if (kind === "h3") {
        doc.fontSize(13).text(plain);
        doc.moveDown(0.2);
      } else if (kind === "bullet") {
        doc.fontSize(11).text(`• ${plain}`, { indent: 12 });
      } else {
        doc.fontSize(11).text(plain);
      }
    }
    doc.end();
  });
}

export interface GenerateOptions {
  title?: string;
  content: string;
  format: DocFormat;
  /** Absolute path to a CJK-capable font; required for `pdf`. */
  fontPath?: string;
}

export interface GenerateResult {
  buffer: Buffer;
  format: DocFormat;
}

/**
 * Generate a document buffer in the requested format. `pdf` requires a
 * `fontPath`; if absent it degrades to Markdown (so the call still succeeds).
 */
export async function generateDocument(opts: GenerateOptions): Promise<GenerateResult> {
  const { title = "", content, format } = opts;
  switch (format) {
    case "md":
      return { buffer: writeMd(title, content), format: "md" };
    case "html":
      return { buffer: writeHtml(title, content), format: "html" };
    case "docx":
      return { buffer: await writeDocx(title, content), format: "docx" };
    case "pdf":
      if (!opts.fontPath) {
        return { buffer: writeMd(title, content), format: "md" };
      }
      return { buffer: await writePdf(title, content, opts.fontPath), format: "pdf" };
    default:
      return { buffer: writeMd(title, content), format: "md" };
  }
}
