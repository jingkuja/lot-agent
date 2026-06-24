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
The tool returns a download link (`/static/assets/...`) — relay that link to the user.

## Behaviour notes

- Generation runs a Python script in a shared virtualenv on the server.
- If the library required for the requested format is **not installed**, the tool
  automatically **degrades to Markdown** and tells you so — pass that note along to the
  user instead of retrying in a loop.

## skills_env — Python dependencies

The server lazily creates a shared virtualenv at `data/skills-env` on first use and installs
the packages below. To set it up manually (e.g. when preparing the box offline):

```bash
python3 -m venv data/skills-env
data/skills-env/bin/pip install python-docx reportlab
```

- `python-docx` → Word `.docx` generation
- `reportlab`   → `.pdf` generation
- `md` and `html` need **no third-party packages** (Python standard library only).
