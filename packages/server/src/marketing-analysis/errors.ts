export class AnalysisError extends Error {
  constructor(readonly code: string, readonly status: 400 | 402 | 404 | 409 | 413 | 503 = 400) { super(code); this.name = "AnalysisError"; }
}
export function classifyDownloadError(message: string): string {
  if (/captcha|challenge|verify|verification|验证|风控/i.test(message)) return "CHALLENGE_REQUIRED";
  if (/cookie|login|log in|sign in|登录|401|403/i.test(message)) return "AUTH_REQUIRED";
  if (/404|not found|deleted|removed|不存在|已删除/i.test(message)) return "SOURCE_UNAVAILABLE";
  if (/duration|longer|时长/i.test(message)) return "DURATION_LIMIT";
  if (/file.*size|too large|exceed|quota|limit/i.test(message)) return "DOWNLOAD_LIMIT";
  if (/no video|unsupported|no formats|image/i.test(message)) return "UNSUPPORTED_SOURCE";
  return "DOWNLOAD_FAILED";
}
