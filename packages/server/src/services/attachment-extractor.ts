import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { ContentPart, ObjectStorage } from "@lot-agent/core";

export const MAX_DOC_CHARS = 30000;

export interface AttachmentRef {
  assetId: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  kind: "image" | "doc";
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function attachmentKind(mime: string): "image" | "doc" {
  return IMAGE_MIMES.has(mime) ? "image" : "doc";
}

/** 把附件转成发给模型的 ContentPart；图片→base64 data URL，文档→解析文本，失败降级。 */
export async function extractAttachment(
  att: AttachmentRef,
  storage: ObjectStorage
): Promise<ContentPart> {
  // storage key = url 去掉静态前缀（/static/uploads/）
  const key = att.url.replace(/^\/static\/uploads\//, "");
  const bytes = await storage.get(key);

  if (attachmentKind(att.mime) === "image") {
    const b64 = bytes.toString("base64");
    return { type: "image", image: { url: `data:${att.mime};base64,${b64}`, mediaType: att.mime } };
  }

  let text: string | null = null;
  try {
    if (att.mime === "application/pdf") {
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else if (
      att.mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else if (att.mime.startsWith("text/") || att.mime === "application/json") {
      text = bytes.toString("utf8");
    }
  } catch {
    text = null;
  }

  if (text == null) {
    return { type: "text", text: `[附件 ${att.filename} 无法解析，已忽略内容]` };
  }

  let body = text;
  if (body.length > MAX_DOC_CHARS) {
    body = body.slice(0, MAX_DOC_CHARS) + "\n…[内容过长已截断]";
  }
  return { type: "text", text: `[附件: ${att.filename}]\n${body}\n[/附件: ${att.filename}]` };
}
