import { describe, expect, it, vi } from "vitest";
import { parseAnalysisSource, validateSourceMetadata, downloaderArgs } from "./source.js";
import { validateCookieFile } from "./download.js";
import { resolveEgressTarget } from "./egress.js";
import { sandboxArgs, isolatedMediaRunner } from "./sandbox.js";

describe("single-platform video sources", () => {
  it.each(["参考：https://b23.tv/abc123。", "参考:b23.tv/abc123", "参考，‘https://b23.tv/abc123’", "[分享标题](https://b23.tv/abc123)"])("uses shared URL boundaries: %s", text => {
    expect(parseAnalysisSource(text)).toEqual({ platform: "bilibili", canonicalUrl: "https://b23.tv/abc123" });
  });
  it("normalizes share text and preserves a selected Bilibili part", () => {
    expect(parseAnalysisSource("看看视频 https://www.bilibili.com/video/BV1xx411c7mD?p=3&share_source=copy 。")).toEqual({ platform: "bilibili", canonicalId: "BV1xx411c7mD", selectedPart: 3, canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=3" });
    expect(parseAnalysisSource("https://v.douyin.com/abcd123/").platform).toBe("douyin");
    expect(parseAnalysisSource("https://xhslink.com/a/abc123").platform).toBe("xiaohongshu");
  });
  it("retains required private XHS tokens without unrelated query params", () => {
    const source = parseAnalysisSource("https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=a%2Bb&xsec_source=pc_share&tracking=x");
    expect(source.canonicalUrl).toContain("xsec_token=a%2Bb"); expect(source.canonicalUrl).not.toContain("tracking");
  });
  it.each(["http://127.0.0.1/a", "https://www.douyin.com.evil.test/video/123456", "https://user:pass@v.douyin.com/abc123/", "https://www.bilibili.com/video/BV1xx411c7mD?p=0", "https://www.bilibili.com/video/BV1xx411c7mD?p=1&p=2", "https://v.douyin.com/abc https://b23.tv/abc", "https://www.xiaohongshu.com/user/profile/123", "file:///tmp/video"])("rejects %s", value => expect(() => parseAnalysisSource(value)).toThrow());
  it("rejects playlists, overlong media and a different selected part", () => {
    const source = parseAnalysisSource("https://www.bilibili.com/video/BV1xx411c7mD?p=2");
    expect(() => validateSourceMetadata({ _type: "playlist", duration: 10 }, source)).toThrow("UNSUPPORTED_SOURCE");
    expect(() => validateSourceMetadata({ duration: 181 }, source)).toThrow("DURATION_LIMIT");
    expect(() => validateSourceMetadata({ duration: 30, webpage_url: source.canonicalUrl.replace("p=2", "p=1") }, source)).toThrow("INVALID_PART");
    expect(() => validateSourceMetadata({ duration: 30, webpage_url: source.canonicalUrl.replace("BV1xx411c7mD", "BV1xx411c7mE") }, source)).toThrow("UNSUPPORTED_SOURCE");
    const short = parseAnalysisSource("https://b23.tv/abc123?p=2");
    expect(short.selectedPart).toBe(2);
    expect(() => validateSourceMetadata({ duration: 30, webpage_url: source.canonicalUrl.replace("p=2", "p=1") }, short)).toThrow("INVALID_PART");
    expect(validateSourceMetadata({ duration: 30, webpage_url: source.canonicalUrl }, short).selectedPart).toBe(2);
  });
  it("fixes command options and restricts cookies to the selected platform", () => {
    const source = parseAnalysisSource("https://www.douyin.com/video/123456789");
    const args = downloaderArgs(source, "download");
    expect(args).toContain("--no-plugin-dirs"); expect(args).not.toContain("--no-check-certificate");
    expect(args.slice(-2)).toEqual(["--", source.canonicalUrl]);
    expect(() => validateCookieFile(".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsecret", source)).toThrow("INVALID_COOKIES");
    expect(validateCookieFile(".douyin.com\tTRUE\t/\tTRUE\t0\tsession\tx", source)).toContain("Netscape");
    const xhs = parseAnalysisSource("https://www.xiaohongshu.com/explore/1234567890abcdef12345678");
    const download = downloaderArgs(xhs, "download");
    expect(download.slice(download.indexOf("--replace-in-metadata"), -2)).toEqual([
      "--replace-in-metadata", "before_dl:url", "^http://([a-zA-Z0-9.-]+\\.xhscdn\\.com)/", "https://\\1/",
    ]);
    expect(downloaderArgs(xhs, "metadata")).not.toContain("--replace-in-metadata");
    expect(args).not.toContain("--replace-in-metadata");
  });
});

describe("downloader isolation", () => {
  it("pins numeric public IPv4 and rejects ports, localhost and reserved answers", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    expect(await resolveEgressTarget("www.bilibili.com:443", resolver)).toEqual({ address: "8.8.8.8", family: 4 });
    await expect(resolveEgressTarget("host.test:22", resolver)).rejects.toThrow("NETWORK_BLOCKED");
    await expect(resolveEgressTarget("127.0.0.1:443", resolver)).rejects.toThrow("NETWORK_BLOCKED");
    for (const address of ["10.0.0.1", "169.254.169.254", "192.0.0.1", "198.18.0.1", "203.0.113.1"]) {
      await expect(resolveEgressTarget("public.test:443", async () => [{ address, family: 4 }])).rejects.toThrow("NETWORK_BLOCKED");
    }
    await expect(resolveEgressTarget("public.test:443", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }])).rejects.toThrow("NETWORK_BLOCKED");
  });
  it("gives decoders no network socket or app filesystem and downloaders only the task socket", async () => {
    const decoder = sandboxArgs("/private/task", "ffmpeg", ["-version"]);
    expect(decoder).toContain("--unshare-all"); expect(decoder).toContain("--clearenv");
    expect(decoder).not.toContain("/egress.sock"); expect(decoder).not.toContain("/app");
    expect(() => sandboxArgs("/private/task", "yt-dlp", [])).toThrow("SANDBOX_REQUIRED");
    const downloader = sandboxArgs("/private/task", "yt-dlp", ["--version"], { path: "/bridge.py", socket: "/task.sock" });
    expect(downloader).toContain("/egress.sock"); expect(downloader).not.toContain("--share-net");
    if (process.platform !== "linux") await expect(isolatedMediaRunner("/tmp").run("ffmpeg", [])).rejects.toThrow("SANDBOX_REQUIRED");
  });
});
