---
name: doc-generation
description: Generate downloadable document files (Word/PDF/Markdown/HTML) from Markdown content
triggers:
  - "生成文档"
  - "导出文档"
  - "生成报告"
  - "导出报告"
  - "下载文档"
  - "生成word"
  - "导出word"
  - "生成pdf"
  - "导出pdf"
  - "文档下载"
  - "generate document"
  - "export document"
  - "generate report"
  - ".docx"
---

When the user asks to **generate, export, or download a document or report**, use the
`generate_document` tool. Do NOT paste a long document into the chat and call it done —
produce a real downloadable file.

## How to call `generate_document`

- `title`: the document title (becomes the top-level heading). Optional but recommended.
- `content`: the full body written in **Markdown**. Supported markup:
  - `#` / `##` / `###` headings
  - `- ` bullet lists
  - paragraphs (blank line between them)
  - inline `**bold**`, `*italic*`, `` `code` `` (rendered as plain text in docx/pdf)
- `format`: one of `docx` (Word, default), `pdf`, `md`, `html`.

Pick the format the user asked for. If they don't specify, default to `docx`.
The tool returns a download link (`/static/documents/...`) — relay that link to the user.

**Call `generate_document` exactly once** with the complete content. Do not call it
repeatedly to "build up" the document — assemble the full Markdown first, then make a
single call. Once it returns a download link, the document is done: give the link to the
user, do not generate it again.

## Behaviour notes

- Generation runs entirely in-process in Node (no Python runtime/venv).
- `docx` is produced with the `docx` package, `pdf` with `pdfkit`, and `md`/`html`
  are plain string builders.

## Dependencies

- `docx` (npm) → Word `.docx` generation
- `pdfkit` (npm) → `.pdf` generation
- PDF embeds a bundled CJK font at `assets/fonts/NotoSansSC-Regular.otf` so Chinese
  renders correctly. If that font is missing, `pdf` degrades to Markdown.
- `md` and `html` need no extra packages.
