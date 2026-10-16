export class AnalysisError extends Error {
  constructor(readonly code: string, readonly status: 400 | 402 | 404 | 409 | 413 | 422 | 503 = 400) { super(code); this.name = "AnalysisError"; }
}
export function classifyDownloadError(message: string): string {
  // Warnings and cookie-help URLs are not evidence that the video needs login.
  // Prefer the final extractor error over earlier, recoverable request failures.
  message = [...message.matchAll(/^ERROR:\s*(.+)$/gm)].at(-1)?.[1] ?? message;
  if (/certificate[_ ]verify[_ ]failed|certificate verification failed/i.test(message)) return "DOWNLOAD_FAILED";
  if (/captcha|challenge|verification|verify (?:you are human|your identity)|验证|风控/i.test(message)) return "CHALLENGE_REQUIRED";
  // Douyin explicitly requests a fresh browser session, which can be anonymous.
  if (/fresh cookies\b|not necessarily logged in/i.test(message)) return "PLATFORM_SESSION_REQUIRED";
  if (/\b(?:log[ -]?in|sign[ -]?in|authentication) (?:is )?required\b|\b(?:requires?|please|must|need to|have to) (?:log[ -]?in|sign[ -]?in|authentication)\b|\bonly available (?:to|for) (?:registered|logged.in) users\b|(?:需要|必须|请先|请).*登录|\bHTTP(?: Error)?[ :]+401\b/i.test(message)) return "AUTH_REQUIRED";
  if (/\bHTTP(?: Error)?[ :]+404\b|not found|deleted|removed|不存在|已删除/i.test(message)) return "SOURCE_UNAVAILABLE";
  if (/duration|longer|时长/i.test(message)) return "DURATION_LIMIT";
  if (/file.*size|too large|exceed|quota|limit/i.test(message)) return "DOWNLOAD_LIMIT";
  if (/no video|unsupported|no formats|image/i.test(message)) return "UNSUPPORTED_SOURCE";
  if (/\bHTTP(?: Error)?[ :]+403\b|\bforbidden\b|access denied/i.test(message)) return "PLATFORM_ACCESS_DENIED";
  if (/\b(?:missing|invalid|expired|valid) (?:browser )?cookies?\b|\bcookies? (?:are |is )?(?:needed|required|missing|invalid|expired)\b/i.test(message)) return "PLATFORM_SESSION_REQUIRED";
  return "DOWNLOAD_FAILED";
}
