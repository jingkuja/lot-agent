import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analysisBrowserArgs, douyinBrowserMetadata, douyinDetailMedia, resolveDouyinBrowser } from "./douyin-browser.js";
import { parseAnalysisSource } from "./source.js";
import { sandboxBrowserArgs } from "./sandbox.js";

const source = parseAnalysisSource("https://www.douyin.com/video/7658289800398589193");
const sample = () => ({ pageUrl: source.canonicalUrl, title: "公开视频", userAgent: "Test Chrome",
  videos: [{ url: "https://v26-web.douyinvod.com/public.mp4?__vid=7658289800398589193", duration: 58.2, width: 576, height: 1024 }] });

describe("anonymous Douyin player", () => {
  it("keeps Linux Crashpad descriptor setup and browser caches inside the temporary sandbox", () => {
    expect(analysisBrowserArgs("/tmp/profile", 3189, "linux")).not.toContain("--disable-crashpad-for-testing");
    expect(analysisBrowserArgs("/tmp/profile", 3189, "darwin")).toContain("--disable-crashpad-for-testing");
    const args = sandboxBrowserArgs({ path: "/bridge.py", socket: "/task.sock" }, analysisBrowserArgs("/tmp/profile", 3189, "linux"));
    const environment = new Map(args.flatMap((value, i) => value === "--setenv" ? [[args[i + 1], args[i + 2]]] : []));
    expect(environment.get("HOME")).toBe("/tmp");
    expect(environment.get("XDG_CACHE_HOME")).toBe("/tmp/cache");
  });
  it("accepts only the matching public player and copies an explicit metadata allowlist", () => {
    const result = douyinBrowserMetadata({ ...sample(), cookies: "must-not-copy", requested_downloads: [{ url: "file:///etc/passwd" }] }, parseAnalysisSource("https://v.douyin.com/Opl7-ZVVzec/"));
    expect(result).toMatchObject({ id: source.canonicalId, duration: 58.2, protocol: "https", http_headers: { Referer: source.canonicalUrl } });
    expect(result).not.toHaveProperty("cookies"); expect(result).not.toHaveProperty("requested_downloads");
  });
  it.each([
    "http://v26-web.douyinvod.com/a?__vid=7658289800398589193", "https://127.0.0.1/a?__vid=7658289800398589193",
    "https://v26-web.douyinvod.com.evil.test/a?__vid=7658289800398589193", "https://user:pass@v26-web.douyinvod.com/a?__vid=7658289800398589193",
    "https://v26-web.douyinvod.com/a?__vid=123456789", "https://v26-web.douyinvod.com/a", "blob:https://www.douyin.com/uuid",
  ])("rejects unrelated or unsafe media: %s", url => {
    const raw = sample(); raw.videos[0].url = url;
    expect(douyinBrowserMetadata(raw, source)).toBeUndefined();
  });
  it("rejects another video, excessive duration/resolution and header injection", () => {
    expect(() => douyinBrowserMetadata({ ...sample(), pageUrl: "https://www.douyin.com/video/123456789" }, source)).toThrow("UNSUPPORTED_SOURCE");
    const raw = sample(); raw.videos[0].duration = 181;
    expect(() => douyinBrowserMetadata(raw, source)).toThrow("DURATION_LIMIT");
    raw.videos[0].duration = 58.2; raw.videos[0].width = 4096;
    expect(() => douyinBrowserMetadata(raw, source)).toThrow("UNSUPPORTED_SOURCE");
    expect(() => douyinBrowserMetadata({ ...sample(), userAgent: "Chrome\r\nCookie: x" }, source)).toThrow("UNSUPPORTED_SOURCE");
  });
  it("binds a blob player to the matching public detail response without relaxing URL safety", () => {
    const raw = sample(); const mediaUrl = raw.videos[0].url.split("?")[0];
    const detail = douyinDetailMedia({ aweme_detail: { aweme_id: source.canonicalId, video: { play_addr: { url_list: [mediaUrl] } } } })!;
    raw.videos[0].url = "blob:https://www.douyin.com/player";
    expect(douyinBrowserMetadata(raw, source, detail)).toMatchObject({ url: mediaUrl, duration: 58.2 });
    expect(douyinBrowserMetadata(raw, source)).toBeUndefined();
    expect(douyinBrowserMetadata(raw, source, { ...detail, id: "123456789" })).toBeUndefined();
    for (const url of [mediaUrl + "?__vid=123456789",
      mediaUrl.replace("https:", "http:"), mediaUrl.replace("v26-web.douyinvod.com", "127.0.0.1"),
      mediaUrl.replace("https://", "https://user:pass@")]) {
      expect(douyinBrowserMetadata(raw, source, { ...detail, urls: [url] })).toBeUndefined();
    }
    raw.videos[0].url = "blob:https://other.example/player";
    expect(douyinBrowserMetadata(raw, source, detail)).toBeUndefined();
    expect(douyinDetailMedia({ aweme_detail: { aweme_id: source.canonicalId, video: { play_addr: { url_list: [123, null] } } } }))
      .toEqual({ id: source.canonicalId, urls: [] });
    expect(douyinDetailMedia({ aweme_detail: { aweme_id: 123456 } })).toBeUndefined();
    expect(douyinDetailMedia(null)).toBeUndefined();
  });
  it("keeps the browser inside an empty, bounded namespace with only private protocol pipes and HTTPS egress", () => {
    const args = sandboxBrowserArgs({ path: "/bridge.py", socket: "/task.sock" }, analysisBrowserArgs("/tmp/profile"));
    expect(args).toContain("--unshare-all"); expect(args).toContain("--clearenv"); expect(args).not.toContain("--bind");
    expect(args).toContain("--remote-debugging-pipe"); expect(args.some(arg => arg.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args).toContain("268435456"); expect(args).not.toContain("/app"); expect(args).not.toContain("/home");
    expect(args).not.toContain("--ignore-certificate-errors"); expect(args).toContain("--proxy-bypass-list=<-loopback>");
  });
  it("cancels a stalled browser process and removes its entire temporary profile", async () => {
    let scratch = "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      await expect(resolveDouyinBrowser(source, controller.signal, async directory => {
        scratch = directory;
        return { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: {} };
      })).rejects.toThrow("PROCESS_CANCELLED");
      expect(scratch).not.toBe("");
      await expect(access(scratch)).rejects.toThrow();
    } finally { clearTimeout(timer); }
  }, 5000);
});
