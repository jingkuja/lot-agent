import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ObjectStorage } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import { generateDocument, type DocFormat } from "./doc-generator.js";

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
};

const SUPPORTED = new Set<DocFormat>(["docx", "pdf", "md", "html"]);

interface DocToolDeps {
  storage: ObjectStorage;
  db: DB;
  /** Absolute path to a CJK-capable font, embedded into generated PDFs. */
  fontPath: string;
}

/**
 * `generate_document` — turns Markdown content into a downloadable document
 * (Word .docx / PDF / Markdown / HTML) entirely in-process (no Python runtime),
 * stores it as an asset, and returns the download URL. Stays available on the
 * deployed box even though `execute_command` is disabled.
 */
export function createDocTool(deps: DocToolDeps): Tool {
  const { storage, db, fontPath } = deps;

  return {
    name: "generate_document",
    description:
      "Generate a downloadable document file from Markdown content. " +
      "Supports Word (docx), PDF, Markdown (md) and HTML. Returns a download URL. " +
      "Use this when the user asks to export, generate, or download a document/report.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Document title (rendered as the top heading). Optional.",
        },
        content: {
          type: "string",
          description:
            "Document body as Markdown. Supports #/##/### headings, '- ' bullets and paragraphs.",
        },
        format: {
          type: "string",
          enum: ["docx", "pdf", "md", "html"],
          description: "Output format (default: docx).",
        },
      },
      required: ["content"],
    },
    async execute(input, context): Promise<ToolResult> {
      const {
        title = "",
        content = "",
        format = "docx",
      } = (input as { title?: string; content?: string; format?: string }) ?? {};

      if (!content.trim()) {
        return { content: "Cannot generate a document: `content` is empty.", isError: true };
      }

      const requested = (SUPPORTED.has(format as DocFormat) ? format : "docx") as DocFormat;
      const userId = context.userId ?? "default";
      const id = randomUUID();

      let buffer: Buffer;
      let actualFmt: DocFormat;
      try {
        const result = await generateDocument({ title, content, format: requested, fontPath });
        buffer = result.buffer;
        actualFmt = result.format;
      } catch (err) {
        return {
          content: `Document generation failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      const key = `${id}.${actualFmt}`;
      const mime = MIME[actualFmt] ?? "application/octet-stream";
      const { url } = await storage.put({ key, body: buffer, contentType: mime });
      await db.createAsset({
        id,
        userId,
        type: "document",
        storageKey: key,
        url,
        mime,
        sizeBytes: buffer.byteLength,
      });

      const degradeNote =
        actualFmt !== requested
          ? `\n注意：无法生成 ${requested}，已降级为 ${actualFmt}。`
          : "";

      return {
        content:
          `已生成文档「${title || key}」(${actualFmt})。\n` +
          `下载链接：${url}\nasset_id: ${id}${degradeNote}`,
      };
    },
  };
}
