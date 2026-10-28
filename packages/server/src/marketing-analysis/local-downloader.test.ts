import { expect, it } from "vitest";
import { localDouyinDownloader, usesDouyinDownloader } from "./local-downloader.js";
import { localProbePolicy } from "./local-probe.js";

it("selects the pinned extractor only for normalized Douyin positional URLs", () => {
  for (const url of ["https://v.douyin.com/Hl0DliV9tPg", "https://www.douyin.com/video/7639213570659567353"]) {
    expect(usesDouyinDownloader(["--ignore-config", "--", url])).toBe(true);
  }
  for (const url of ["http://v.douyin.com/Hl0DliV9tPg", "https://www.douyin.com.evil.test/video/123456",
    "https://user@www.douyin.com/video/123456", "https://www.douyin.com:443/video/123456",
    "https://www.douyin.com/video/123456?x=1", "https://www.douyin.com/video/123456#fragment",
    "https://www.douyin.com/user/123456", "https://www.bilibili.com/video/BV1234567890"]) {
    expect(usesDouyinDownloader(["--", url])).toBe(false);
  }
  for (const args of [["--version"], ["--load-info-json", "/work/browser-source.json"],
    ["--referer", "https://www.douyin.com/video/123456"]]) expect(usesDouyinDownloader(args)).toBe(false);
});

it("grants read access to only the installed zipapp, not the repository", () => {
  const path = localDouyinDownloader();
  expect(path).toMatch(/\/data\/media-tools\/yt-dlp-douyin-2026\.08\.19$/);
  const policy = localProbePolicy("/private/task", 1234, undefined, path);
  expect(policy).toContain(`(allow file-read* (literal ${JSON.stringify(path)}))`);
  expect(policy).not.toContain(`(subpath ${JSON.stringify(path.split("/data/media-tools/")[0])})`);
  expect(localProbePolicy("/private/task")).not.toContain("media-tools");
});
