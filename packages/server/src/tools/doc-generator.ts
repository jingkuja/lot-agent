import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import { marked, Marked, type Token, type Tokens } from "marked";

/**
 * Pure-TS document generator — turns Markdown content into a downloadable
 * document buffer (Word / PDF / Markdown / HTML). Built on marked's token
 * stream so the full markdown feature set (h1-h6, ordered/unordered nested
 * lists, tables, fenced code, blockquotes, links, hr, bold/italic/inline
 * code) renders as real document structure instead of leaking raw syntax.
 */

export type DocFormat = "docx" | "pdf" | "md" | "html";

const DEFAULT_ACCENT = "4472C4";
const GRAY_TEXT = "595959";
const CODE_BG = "F5F6F8";
const BORDER_GRAY = "CCCCCC";

/** 6-hex accent color, no '#'. Garbage input falls back to the default. */
export function normalizeAccent(input?: string): string {
  const hex = (input ?? "").trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : DEFAULT_ACCENT;
}

// ── inline handling ──────────────────────────────────────────────────────────

interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

/** Flatten marked inline tokens into style-tagged runs. */
function inlineRuns(tokens: Token[] | undefined, base: Partial<InlineRun> = {}): InlineRun[] {
  const out: InlineRun[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlineRuns(t.tokens, { ...base, bold: true }));
        break;
      case "em":
        out.push(...inlineRuns(t.tokens, { ...base, italic: true }));
        break;
      case "del":
        out.push(...inlineRuns(t.tokens, base));
        break;
      case "codespan":
        out.push({ ...base, text: t.text, code: true });
        break;
      case "link":
        out.push(...inlineRuns(t.tokens, { ...base, link: t.href }));
        break;
      case "image":
        out.push({ ...base, text: t.text || t.href });
        break;
      case "br":
        out.push({ ...base, text: "\n" });
        break;
      case "escape":
        out.push({ ...base, text: t.text });
        break;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineRuns(tt.tokens, base));
        else out.push({ ...base, text: tt.text });
        break;
      }
      default:
        if ("text" in t && typeof (t as { text?: unknown }).text === "string") {
          out.push({ ...base, text: (t as { text: string }).text });
        }
    }
  }
  return out.filter((r) => r.text.length > 0);
}

function runsPlain(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── markdown writer ──────────────────────────────────────────────────────────

function writeMd(title: string, content: string): Buffer {
  let out = "";
  if (title) out += `# ${title}\n\n`;
  out += content;
  if (!out.endsWith("\n")) out += "\n";
  return Buffer.from(out, "utf8");
}

// ── HTML writer ──────────────────────────────────────────────────────────────

/** Dedicated instance: raw HTML in the source is escaped, not passed through. */
const htmlMarked = new Marked({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.raw);
    },
  },
});

function writeHtml(title: string, content: string, accent: string): Buffer {
  const body = htmlMarked.parse(content, { async: false }) as string;
  const a = `#${accent}`;
  const css = `
body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,sans-serif;
max-width:800px;margin:40px auto;padding:0 24px;line-height:1.75;color:#1a1a22}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.4em 0 .6em}
h1{font-size:1.8em;color:${a};border-bottom:2px solid ${a};padding-bottom:.3em}
h2{font-size:1.45em;color:${a}}
h3{font-size:1.2em}
a{color:${a}}
code{background:#f3f3f7;padding:2px 5px;border-radius:4px;font-size:.9em;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
pre{background:${"#" + CODE_BG};border:1px solid #e4e6ea;border-radius:8px;padding:14px 16px;overflow-x:auto}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.4em 1em;border-left:4px solid ${a};color:#555;background:#fafafc}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #d5d7dc;padding:8px 12px;text-align:left}
th{background:${a};color:#fff}
tr:nth-child(even) td{background:#f7f8fa}
hr{border:none;border-top:1px solid #ddd;margin:2em 0}
img{max-width:100%}`.trim();
  const parts = [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title || "Document")}</title>`,
    `<style>${css}</style></head><body>`,
  ];
  if (title) parts.push(`<h1 class="doc-title">${escapeHtml(title)}</h1>`);
  parts.push(body, "</body></html>");
  return Buffer.from(parts.join("\n"), "utf8");
}

// ── DOCX writer ──────────────────────────────────────────────────────────────

const DOCX_HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const MONO_FONT = { ascii: "Consolas", hAnsi: "Consolas", eastAsia: "Microsoft YaHei" };

interface DocxCtx {
  accent: string;
  /** ordered lists restart numbering via a fresh instance each */
  olInstance: number;
}

function docxRuns(runs: InlineRun[], accent: string): (TextRun | ExternalHyperlink)[] {
  return runs.map((r) => {
    const run = new TextRun({
      text: r.text,
      bold: r.bold,
      italics: r.italic,
      font: r.code ? MONO_FONT : undefined,
      shading: r.code ? { type: ShadingType.CLEAR, fill: "F3F3F7" } : undefined,
      color: r.link ? accent : undefined,
      underline: r.link ? {} : undefined,
    });
    return r.link ? new ExternalHyperlink({ children: [run], link: r.link }) : run;
  });
}

function docxListItems(
  token: Tokens.List,
  level: number,
  ctx: DocxCtx,
  out: (Paragraph | Table)[]
): void {
  const instance = token.ordered ? ++ctx.olInstance : 0;
  for (const item of token.items) {
    for (const child of item.tokens) {
      if (child.type === "list") {
        docxListItems(child as Tokens.List, level + 1, ctx, out);
      } else if (child.type === "text" || child.type === "paragraph") {
        const runs = inlineRuns((child as Tokens.Text).tokens ?? [], {});
        out.push(
          new Paragraph({
            children: docxRuns(runs.length ? runs : [{ text: (child as Tokens.Text).text }], ctx.accent),
            ...(token.ordered
              ? { numbering: { reference: "doc-ol", level: Math.min(level, 2), instance } }
              : { bullet: { level: Math.min(level, 2) } }),
          })
        );
      } else {
        docxBlocks([child], ctx, out);
      }
    }
  }
}

function docxTable(token: Tokens.Table, ctx: DocxCtx): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: BORDER_GRAY };
  const cell = (c: Tokens.TableCell, header: boolean) =>
    new TableCell({
      children: [
        new Paragraph({
          children: header
            ? [new TextRun({ text: runsPlain(inlineRuns(c.tokens)) || c.text, bold: true, color: "FFFFFF" })]
            : docxRuns(inlineRuns(c.tokens), ctx.accent),
        }),
      ],
      shading: header ? { type: ShadingType.CLEAR, fill: ctx.accent } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: border, bottom: border, left: border, right: border,
      insideHorizontal: border, insideVertical: border,
    },
    rows: [
      new TableRow({ tableHeader: true, children: token.header.map((c) => cell(c, true)) }),
      ...token.rows.map((row) => new TableRow({ children: row.map((c) => cell(c, false)) })),
    ],
  });
}

function docxBlocks(tokens: Token[], ctx: DocxCtx, out: (Paragraph | Table)[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        out.push(
          new Paragraph({
            children: docxRuns(inlineRuns(h.tokens), ctx.accent),
            heading: DOCX_HEADINGS[Math.min(h.depth, 6) - 1],
          })
        );
        break;
      }
      case "paragraph": {
        out.push(
          new Paragraph({
            children: docxRuns(inlineRuns((t as Tokens.Paragraph).tokens), ctx.accent),
            spacing: { after: 120 },
          })
        );
        break;
      }
      case "list":
        docxListItems(t as Tokens.List, 0, ctx, out);
        break;
      case "table":
        out.push(docxTable(t as Tokens.Table, ctx));
        out.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
        break;
      case "code": {
        const lines = (t as Tokens.Code).text.split("\n");
        lines.forEach((line, i) => {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: MONO_FONT, size: 18 })],
              shading: { type: ShadingType.CLEAR, fill: CODE_BG },
              spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 120 : 0 },
            })
          );
        });
        break;
      }
      case "blockquote": {
        for (const inner of (t as Tokens.Blockquote).tokens) {
          if (inner.type !== "paragraph" && inner.type !== "text") continue;
          out.push(
            new Paragraph({
              children: docxRuns(
                inlineRuns((inner as Tokens.Paragraph).tokens ?? [], { italic: true }),
                ctx.accent
              ),
              indent: { left: 360 },
              border: { left: { style: BorderStyle.SINGLE, size: 24, color: ctx.accent, space: 8 } },
              spacing: { before: 120, after: 120 },
            })
          );
        }
        break;
      }
      case "hr":
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "DDDDDD" } },
            spacing: { before: 200, after: 200 },
          })
        );
        break;
      case "html":
        out.push(new Paragraph({ children: [new TextRun((t as Tokens.HTML).text)] }));
        break;
      case "text": {
        const runs = inlineRuns((t as Tokens.Text).tokens ?? []);
        out.push(
          new Paragraph({
            children: docxRuns(runs.length ? runs : [{ text: (t as Tokens.Text).text }], ctx.accent),
          })
        );
        break;
      }
      case "space":
        break;
      default:
        break;
    }
  }
}

async function writeDocx(title: string, content: string, accent: string): Promise<Buffer> {
  const ctx: DocxCtx = { accent, olInstance: 0 };
  const children: (Paragraph | Table)[] = [];
  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  }
  docxBlocks(marked.lexer(content), ctx, children);

  const cjk = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" };
  const heading = (size: number) => ({
    run: { size, bold: true, color: accent, font: cjk },
    paragraph: { spacing: { before: 240, after: 120 } },
  });
  const doc = new Document({
    styles: {
      default: {
        document: { run: { size: 21, font: cjk }, paragraph: { spacing: { line: 300 } } },
        title: {
          run: { size: 44, bold: true, color: "1F2430", font: cjk },
          paragraph: { spacing: { after: 240 } },
        },
        heading1: heading(32),
        heading2: heading(27),
        heading3: { ...heading(24), run: { ...heading(24).run, color: "1F2430" } },
        heading4: { ...heading(22), run: { ...heading(22).run, color: "1F2430" } },
        heading5: { ...heading(21), run: { ...heading(21).run, color: GRAY_TEXT } },
        heading6: { ...heading(21), run: { ...heading(21).run, color: GRAY_TEXT } },
      },
    },
    numbering: {
      config: [
        {
          reference: "doc-ol",
          levels: [0, 1, 2].map((l) => ({
            level: l,
            format: LevelFormat.DECIMAL,
            text: `%${l + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// ── PDF writer ───────────────────────────────────────────────────────────────

const PDF_HEADING_SIZES = [22, 17, 14.5, 13, 12, 11.5];
const PDF_BODY_SIZE = 10.5;
const PDF_CODE_SIZE = 9.5;

type Pdf = InstanceType<typeof PDFDocument>;

function pdfUsableWidth(doc: Pdf): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function pdfEnsureRoom(doc: Pdf, height: number): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** Render style-tagged runs as one flowing text block (fake bold via stroke). */
function pdfRuns(
  doc: Pdf,
  runs: InlineRun[],
  opts: { size?: number; color?: string; indent?: number; prefix?: string }
): void {
  const size = opts.size ?? PDF_BODY_SIZE;
  const color = opts.color ?? "#1a1a22";
  const x = doc.page.margins.left + (opts.indent ?? 0);
  const width = pdfUsableWidth(doc) - (opts.indent ?? 0);
  const all = opts.prefix ? [{ text: opts.prefix }, ...runs] : runs;
  if (!all.length) return;
  doc.fontSize(size).lineWidth(0.4);
  all.forEach((r, i) => {
    const fill = r.code ? "#B93A5B" : r.link ? "#2E5FA3" : color;
    doc.fillColor(fill).strokeColor(fill);
    const o = {
      continued: i < all.length - 1,
      stroke: !!r.bold,
      fill: true,
      oblique: r.italic ? 12 : 0,
      underline: !!r.link,
      width,
      link: r.link,
    };
    if (i === 0) doc.text(r.text, x, doc.y, o);
    else doc.text(r.text, o);
  });
  doc.x = doc.page.margins.left;
}

function pdfList(doc: Pdf, token: Tokens.List, level: number): void {
  let n = typeof token.start === "number" && token.start > 0 ? token.start : 1;
  for (const item of token.items) {
    for (const child of item.tokens) {
      if (child.type === "list") {
        pdfList(doc, child as Tokens.List, level + 1);
      } else if (child.type === "text" || child.type === "paragraph") {
        const runs = inlineRuns((child as Tokens.Text).tokens ?? []);
        const marker = token.ordered ? `${n}. ` : "•  ";
        pdfEnsureRoom(doc, PDF_BODY_SIZE * 2);
        pdfRuns(doc, runs.length ? runs : [{ text: (child as Tokens.Text).text }], {
          indent: 14 + level * 16,
          prefix: marker,
        });
        doc.moveDown(0.25);
      }
    }
    if (token.ordered) n++;
  }
  if (level === 0) doc.moveDown(0.35);
}

function pdfTable(doc: Pdf, token: Tokens.Table, accent: string): void {
  const startX = doc.page.margins.left;
  const usable = pdfUsableWidth(doc);
  const cols = token.header.length || 1;
  const colW = usable / cols;
  const pad = 6;
  const rows: { cells: string[]; header: boolean }[] = [
    { cells: token.header.map((c) => runsPlain(inlineRuns(c.tokens)) || c.text), header: true },
    ...token.rows.map((r) => ({
      cells: r.map((c) => runsPlain(inlineRuns(c.tokens)) || c.text),
      header: false,
    })),
  ];
  doc.moveDown(0.3);
  for (const row of rows) {
    doc.fontSize(PDF_BODY_SIZE);
    const rowH =
      Math.max(
        ...row.cells.map((t) => doc.heightOfString(t || " ", { width: colW - pad * 2 })),
        PDF_BODY_SIZE + 2
      ) + pad * 2;
    pdfEnsureRoom(doc, rowH);
    const y = doc.y;
    row.cells.forEach((text, ci) => {
      const x = startX + ci * colW;
      if (row.header) doc.rect(x, y, colW, rowH).fill(`#${accent}`);
      doc.rect(x, y, colW, rowH).lineWidth(0.7).strokeColor(`#${BORDER_GRAY}`).stroke();
      doc
        .fillColor(row.header ? "#FFFFFF" : "#1a1a22")
        .text(text, x + pad, y + pad, { width: colW - pad * 2 });
    });
    doc.y = y + rowH;
    doc.x = startX;
  }
  doc.moveDown(0.6);
}

function pdfCode(doc: Pdf, token: Tokens.Code): void {
  const usable = pdfUsableWidth(doc);
  const pad = 10;
  doc.fontSize(PDF_CODE_SIZE);
  const h = doc.heightOfString(token.text || " ", { width: usable - pad * 2 }) + pad * 2;
  pdfEnsureRoom(doc, Math.min(h, doc.page.height / 2));
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.rect(x, y, usable, h).fill(`#${CODE_BG}`);
  doc.fillColor("#333844").text(token.text, x + pad, y + pad, { width: usable - pad * 2 });
  doc.y = y + h;
  doc.x = x;
  doc.moveDown(0.5);
}

function pdfBlocks(doc: Pdf, tokens: Token[], accent: string): void {
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        const size = PDF_HEADING_SIZES[Math.min(h.depth, 6) - 1];
        const color = h.depth <= 2 ? `#${accent}` : "#1F2430";
        pdfEnsureRoom(doc, size * 3);
        doc.moveDown(0.5);
        pdfRuns(doc, inlineRuns(h.tokens).map((r) => ({ ...r, bold: true })), { size, color });
        if (h.depth === 1) {
          const y = doc.y + 3;
          doc
            .moveTo(doc.page.margins.left, y)
            .lineTo(doc.page.margins.left + pdfUsableWidth(doc), y)
            .lineWidth(1.2)
            .strokeColor(`#${accent}`)
            .stroke();
          doc.y = y + 6;
        }
        doc.moveDown(0.25);
        break;
      }
      case "paragraph":
        pdfEnsureRoom(doc, PDF_BODY_SIZE * 2);
        pdfRuns(doc, inlineRuns((t as Tokens.Paragraph).tokens), {});
        doc.moveDown(0.5);
        break;
      case "list":
        pdfList(doc, t as Tokens.List, 0);
        break;
      case "table":
        pdfTable(doc, t as Tokens.Table, accent);
        break;
      case "code":
        pdfCode(doc, t as Tokens.Code);
        break;
      case "blockquote": {
        const inner = (t as Tokens.Blockquote).tokens
          .filter((x): x is Tokens.Paragraph => x.type === "paragraph" || x.type === "text")
          .flatMap((x) => inlineRuns(x.tokens ?? []));
        doc.fontSize(PDF_BODY_SIZE);
        const text = runsPlain(inner) || " ";
        const h = doc.heightOfString(text, { width: pdfUsableWidth(doc) - 24 }) + 12;
        pdfEnsureRoom(doc, h);
        const y = doc.y;
        doc.rect(doc.page.margins.left, y, 3, h).fill(`#${accent}`);
        doc
          .fillColor(`#${GRAY_TEXT}`)
          .text(text, doc.page.margins.left + 16, y + 6, {
            width: pdfUsableWidth(doc) - 24,
            oblique: 8,
          });
        doc.y = y + h;
        doc.x = doc.page.margins.left;
        doc.moveDown(0.5);
        break;
      }
      case "hr": {
        pdfEnsureRoom(doc, 20);
        const y = doc.y + 8;
        doc
          .moveTo(doc.page.margins.left, y)
          .lineTo(doc.page.margins.left + pdfUsableWidth(doc), y)
          .lineWidth(0.8)
          .strokeColor("#DDDDDD")
          .stroke();
        doc.y = y + 10;
        break;
      }
      case "html":
        pdfRuns(doc, [{ text: (t as Tokens.HTML).text }], {});
        doc.moveDown(0.5);
        break;
      case "text": {
        const runs = inlineRuns((t as Tokens.Text).tokens ?? []);
        pdfRuns(doc, runs.length ? runs : [{ text: (t as Tokens.Text).text }], {});
        doc.moveDown(0.5);
        break;
      }
      default:
        break;
    }
  }
}

function writePdf(title: string, content: string, fontPath: string, accent: string): Promise<Buffer> {
  return new Promise((res, rej) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => res(Buffer.concat(chunks)));
    doc.on("error", rej);

    // Single CJK font for the whole document — bold is faked by stroking,
    // italic by obliquing. Without a CJK face, Chinese renders blank.
    doc.registerFont("body", fontPath);
    doc.font("body");

    if (title) {
      doc.fontSize(24).fillColor("#1F2430").lineWidth(0.5).strokeColor("#1F2430");
      doc.text(title, { stroke: true, fill: true });
      const y = doc.y + 6;
      doc
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.margins.left + pdfUsableWidth(doc), y)
        .lineWidth(2)
        .strokeColor(`#${accent}`)
        .stroke();
      doc.y = y + 14;
    }
    pdfBlocks(doc, marked.lexer(content), accent);

    // page numbers footer
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8.5)
        .fillColor("#999999")
        .text(`${i + 1} / ${range.count}`, doc.page.margins.left, doc.page.height - 40, {
          width: pdfUsableWidth(doc),
          align: "center",
          lineBreak: false,
        });
    }
    doc.end();
  });
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface GenerateOptions {
  title?: string;
  content: string;
  format: DocFormat;
  /** Absolute path to a CJK-capable font; required for `pdf`. */
  fontPath?: string;
  /** 6-hex accent color for headings/tables/rules (e.g. "1F4E79"). */
  accentColor?: string;
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
  const accent = normalizeAccent(opts.accentColor);
  switch (format) {
    case "md":
      return { buffer: writeMd(title, content), format: "md" };
    case "html":
      return { buffer: writeHtml(title, content, accent), format: "html" };
    case "docx":
      return { buffer: await writeDocx(title, content, accent), format: "docx" };
    case "pdf":
      if (!opts.fontPath) {
        return { buffer: writeMd(title, content), format: "md" };
      }
      return { buffer: await writePdf(title, content, opts.fontPath, accent), format: "pdf" };
    default:
      return { buffer: writeMd(title, content), format: "md" };
  }
}
