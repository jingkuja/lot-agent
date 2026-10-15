import type { AnalysisSource } from "@lot-agent/core/marketing-analysis";
import { marketingSourceUrls, marketingVideoPlatform } from "@lot-agent/core/marketing-video";
import { AnalysisError } from "./errors.js";

/** Pure normalization. DNS and every redirect are separately enforced by the
 * downloader's pinned egress; this function is not an SSRF boundary alone. */
export function parseAnalysisSource(shareText: string): AnalysisSource {
  if (!shareText || shareText.length > 4000) throw new AnalysisError("INVALID_SOURCE");
  const links = marketingSourceUrls(shareText);
  if (links.length !== 1) throw new AnalysisError("SINGLE_LINK_REQUIRED");
  const raw = links[0].replace(/[。，、；;！!？?）)\]}]+$/u, "");
  let url: URL;
  try { url = new URL(raw); } catch { throw new AnalysisError("INVALID_SOURCE"); }
  if (url.username || url.password || url.port || url.hash || /[\\\u0000-\u001f]/.test(raw)) throw new AnalysisError("INVALID_SOURCE");
  if (!marketingVideoPlatform(url)) throw new AnalysisError("UNSUPPORTED_SOURCE");
  const host = url.hostname; const path = url.pathname.replace(/\/$/, "");
  const clean = new URL(`https://${host}${path}`);
  const params = [...url.searchParams.keys()];
  if (new Set(params).size !== params.length) throw new AnalysisError("INVALID_SOURCE");
  if (["v.douyin.com", "b23.tv", "xhslink.com"].includes(host) && /^\/(?:[a-z]\/)?[A-Za-z0-9_-]{3,80}$/.test(path)) {
    if (host === "b23.tv" && url.searchParams.has("p")) clean.searchParams.set("p", part(url.searchParams.get("p")));
    return { platform: host === "v.douyin.com" ? "douyin" : host === "b23.tv" ? "bilibili" : "xiaohongshu", canonicalUrl: clean.href,
      ...(host === "b23.tv" && clean.searchParams.has("p") ? { selectedPart: Number(clean.searchParams.get("p")) } : {}) };
  }
  let match: RegExpMatchArray | null;
  if ((["www.douyin.com", "douyin.com"].includes(host) && (match = path.match(/^\/video\/(\d{5,30})$/)))
    || (["www.iesdouyin.com", "iesdouyin.com"].includes(host) && (match = path.match(/^\/share\/video\/(\d{5,30})$/)))) {
    return { platform: "douyin", canonicalId: match![1], canonicalUrl: `https://www.douyin.com/video/${match![1]}` };
  }
  if (["www.xiaohongshu.com", "xiaohongshu.com"].includes(host) && (match = path.match(/^\/(?:explore|discovery\/item)\/([a-fA-F0-9]{24})$/))) {
    const canonical = new URL(`https://www.xiaohongshu.com/explore/${match[1]}`);
    for (const key of ["xsec_token", "xsec_source"]) {
      const value = url.searchParams.get(key);
      if (value) { if (value.length > 1024 || /[\u0000-\u001f]/.test(value)) throw new AnalysisError("INVALID_SOURCE"); canonical.searchParams.set(key, value); }
    }
    return { platform: "xiaohongshu", canonicalId: match[1], canonicalUrl: canonical.href };
  }
  if (["www.bilibili.com", "m.bilibili.com", "bilibili.com"].includes(host) && (match = path.match(/^\/video\/(BV[A-Za-z0-9]{10})$/))) {
    const selectedPart = Number(part(url.searchParams.get("p")));
    return { platform: "bilibili", canonicalId: match[1], selectedPart, canonicalUrl: `https://www.bilibili.com/video/${match[1]}?p=${selectedPart}` };
  }
  throw new AnalysisError("UNSUPPORTED_SOURCE");
}
function part(value: string | null) {
  if (value === null) return "1";
  if (!/^[1-9]\d{0,3}$/.test(value)) throw new AnalysisError("INVALID_PART");
  return value;
}

/** No user-controlled options, templates, external downloaders or plugins. */
export function downloaderArgs(source: AnalysisSource, mode: "metadata" | "download", cookies = false): string[] {
  const safe = parseAnalysisSource(source.canonicalUrl);
  const args = ["--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-js-runtimes", "--no-remote-components",
    "--no-playlist", "--no-check-formats", "--no-progress", "--no-warnings", "--socket-timeout", "20", "--retries", "1", "--fragment-retries", "1",
    "--extractor-retries", "1", "--concurrent-fragments", "1", "--proxy", "http://127.0.0.1:3189"];
  if (cookies) args.push("--cookies", "/work/cookies.txt");
  if (mode === "metadata") args.push("--skip-download", "--dump-single-json");
  else args.push("--downloader", "native", "--hls-prefer-native", "--fixup", "never", "--max-filesize", "100M", "--no-mtime",
    "--format", "best[vcodec!=none][acodec!=none][width<=1920][height<=1920]/bestvideo[width<=1920][height<=1920]/best[vcodec!=none][width<=1920][height<=1920]",
    "--output", "/work/source.%(ext)s", "--print-json", "--no-simulate");
  // The XHS extractor returns HTTP CDN URLs even when the same object is
  // available over HTTPS. Upgrade only that known CDN before downloading;
  // the egress proxy continues to reject all cleartext HTTP requests.
  if (mode === "download" && source.platform === "xiaohongshu") args.push("--replace-in-metadata", "before_dl:url",
    "^http://([a-zA-Z0-9.-]+\\.xhscdn\\.com)/", "https://\\1/");
  return [...args, "--", safe.canonicalUrl];
}

export function validateSourceMetadata(raw: Record<string, unknown>, source: AnalysisSource): AnalysisSource {
  if (raw._type === "playlist" || raw.entries || raw.is_live || ["is_live", "is_upcoming"].includes(String(raw.live_status))) throw new AnalysisError("UNSUPPORTED_SOURCE");
  const durationMs = Math.ceil(Number(raw.duration) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new AnalysisError("UNSUPPORTED_SOURCE");
  if (durationMs > 180_000) throw new AnalysisError("DURATION_LIMIT");
  const resolved = parseAnalysisSource(String(raw.webpage_url ?? source.canonicalUrl));
  if (resolved.platform !== source.platform || !resolved.canonicalId) throw new AnalysisError("UNSUPPORTED_SOURCE");
  if (source.canonicalId && resolved.canonicalId !== source.canonicalId) throw new AnalysisError("UNSUPPORTED_SOURCE");
  if (source.platform === "bilibili" && source.selectedPart && resolved.selectedPart !== source.selectedPart) throw new AnalysisError("INVALID_PART");
  if (Array.isArray(raw.formats) && !raw.formats.some((f: any) => f.vcodec !== "none" && f.url)) throw new AnalysisError("UNSUPPORTED_SOURCE");
  return { ...resolved, durationMs, title: String(raw.title ?? "").slice(0, 500), author: String(raw.uploader ?? "").slice(0, 200) };
}
