const SAME_ORIGIN_DOWNLOAD_PREFIXES = ["/static/", "/api/public/comic-drama-media/"] as const;

export type WindowOpenDecision = "download" | "external" | "deny";

/**
 * Classifies renderer `window.open` / `target="_blank"` requests safely:
 * - Same-origin static or comic-drama private media URLs trigger Electron's controlled download flow.
 * - Other same-origin (loopback) URLs are denied so local shell addresses never leak to the system browser.
 * - External http(s) URLs open in the OS browser; non-http(s) schemes are denied.
 */
export function classifyWindowOpen(url: string, rendererOrigin: string): WindowOpenDecision {
  const target = URL.parse(url);
  if (!target) return "deny";
  if (target.protocol !== "http:" && target.protocol !== "https:") return "deny";
  if (target.origin === rendererOrigin) {
    return SAME_ORIGIN_DOWNLOAD_PREFIXES.some((prefix) => target.pathname.startsWith(prefix)) ? "download" : "deny";
  }
  return "external";
}
