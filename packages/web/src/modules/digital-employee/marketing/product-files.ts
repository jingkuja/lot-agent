export const DOCUMENT_ACCEPT = ".pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.gif";

/** Browsers leave `type` empty for some extensions; the upload needs one. */
const MIME_BY_EXTENSION: Record<string, string> = { md: "text/markdown", txt: "text/plain", csv: "text/csv" };

export const DOCUMENT_ERROR_TEXT: Record<string, string> = {
  OCR_REQUIRED: "这份文件是扫描件或图片，暂时读不了文字",
  EMPTY_TEXT: "文件里没有读到文字",
  OCR_EMPTY_TEXT: "文件里没有读到文字",
  OCR_CREDENTIAL_REQUIRED: "读图片要先配好 Key，配好后可以重试",
  OCR_QUOTA_EXCEEDED: "额度不足，充值后可以重试，已读完的页不会重复计费",
  OCR_OUTPUT_TRUNCATED: "这张图片内容太多，没读完，可以重试",
  PASSWORD_REQUIRED: "文件设置了密码，去掉密码后再上传",
  TEXT_LIMIT_EXCEEDED: "文件太大，暂时读不完",
  DOCUMENT_TOO_LARGE: "文件太大，暂时读不完",
  TOO_MANY_PAGES: "文件太大，暂时读不完",
  SOURCE_MISSING: "原文件已不在，请重新上传",
  QUEUE_UNAVAILABLE: "暂时排不上队，可以重试",
  PARSE_STALLED: "处理超时，可以重试",
  MODEL_UNAVAILABLE: "还没有可用的模型，配好 Key 后可以重试",
  MODEL_FAILED: "这次没整理出来，可以重试",
  MODEL_OUTPUT_INVALID: "这次没整理出来，可以重试",
};

export const DOCUMENT_NO_RETRY = new Set([
  "OCR_REQUIRED", "EMPTY_TEXT", "OCR_EMPTY_TEXT", "PASSWORD_REQUIRED", "TEXT_LIMIT_EXCEEDED", "DOCUMENT_TOO_LARGE", "TOO_MANY_PAGES", "SOURCE_MISSING",
]);

export function uploadable(file: File): File {
  if (file.type) return file;
  const type = MIME_BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""];
  return type ? new File([file], file.name, { type }) : file;
}
