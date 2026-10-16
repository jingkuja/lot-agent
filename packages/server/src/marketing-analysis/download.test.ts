import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAnalysisSource, type AnalysisDownloadRuntime } from "./download.js";
import { AnalysisError } from "./errors.js";

const shareText = "https://v.douyin.com/Opl7-ZVVzec/";
const metadata = { id: "7658289800398589193", webpage_url: "https://www.douyin.com/video/7658289800398589193", duration: 58.2,
  width: 576, height: 1024, url: "https://v26-web.douyinvod.com/video.mp4?__vid=7658289800398589193", ext: "mp4" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(diagnostic = "ERROR: [Douyin] 7658289800398589193: Fresh cookies (not necessarily logged in) are needed") {
  const directory = await mkdtemp(join(tmpdir(), "lot-browser-download-test-")); directories.push(directory);
  const resolveDouyin = vi.fn(async () => metadata);
  const error = new AnalysisError("MEDIA_PROCESS_FAILED"); Object.defineProperty(error, "diagnostic", { value: diagnostic });
  const run = vi.fn<AnalysisDownloadRuntime["runner"]["run"]>(async (_command, args) => {
    if (args.includes("--version")) return { stdout: "2026.07.04", stderr: "" };
    if (args.includes("--skip-download")) throw error;
    const info = join(directory, "browser-source.json");
    expect(JSON.parse(await readFile(info, "utf8"))).toEqual(metadata);
    expect((await stat(info)).mode & 0o777).toBe(0o600);
    expect(args).toContain("--load-info-json"); expect(args).toContain("--proxy");
    expect(args).not.toContain(shareText); expect(args).not.toContain(metadata.webpage_url);
    await writeFile(join(directory, "source.mp4"), "fixture bytes");
    return { stdout: JSON.stringify(metadata), stderr: "" };
  });
  const close = vi.fn(async () => {});
  const runtime: AnalysisDownloadRuntime = { runner: { run }, resolveDouyin, egress: { bytes: 42, close } };
  const input = { shareText, directory, bridgePath: "", expectedDownloaderVersion: "2026.07.04", signal: new AbortController().signal };
  return { input, runtime, run, resolveDouyin, close, directory };
}

describe("Douyin download fallback", () => {
  it.each(["Fresh cookies (not necessarily logged in) are needed", "HTTP Error 403: Forbidden"])("tries an anonymous browser once after %s, then downloads the validated URL", async message => {
    const f = await fixture(`ERROR: ${message}`);
    const result = await downloadAnalysisSource(f.input, async () => f.runtime);
    expect(f.resolveDouyin).toHaveBeenCalledTimes(1);
    expect(result.source).toMatchObject({ canonicalId: metadata.id, durationMs: 58200, mediaKey: "source.mp4" });
    expect(result.source.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(f.directory)).toEqual(["source.mp4"]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["Login is required", "AUTH_REQUIRED"], ["Please complete captcha verification", "CHALLENGE_REQUIRED"],
    ["HTTP Error 404: Not Found", "SOURCE_UNAVAILABLE"], ["certificate verify failed", "DOWNLOAD_FAILED"],
  ])("does not retry explicit restrictions or unrelated failures: %s", async (diagnostic, code) => {
    const f = await fixture(`ERROR: ${diagnostic}`);
    await expect(downloadAnalysisSource(f.input, async () => f.runtime)).rejects.toThrow(code);
    expect(f.resolveDouyin).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("never launches a browser after egress rejection or cancellation", async () => {
    for (const cancelled of [false, true]) {
      const f = await fixture();
      if (cancelled) f.input.signal = AbortSignal.abort();
      else Object.defineProperty(f.runtime.egress, "failure", { value: "NETWORK_BLOCKED" });
      await expect(downloadAnalysisSource(f.input, async () => f.runtime)).rejects.toThrow(cancelled ? "PROCESS_CANCELLED" : "NETWORK_BLOCKED");
      expect(f.resolveDouyin).not.toHaveBeenCalled();
    }
  });
  it("keeps other platforms on their existing downloader path", async () => {
    const f = await fixture(); f.input.shareText = "https://b23.tv/abc123";
    await expect(downloadAnalysisSource(f.input, async () => f.runtime)).rejects.toThrow("PLATFORM_SESSION_REQUIRED");
    expect(f.resolveDouyin).not.toHaveBeenCalled();
  });
  it("removes imported cookies and partial files after a browser challenge without retrying", async () => {
    const f = await fixture();
    f.resolveDouyin.mockImplementation(async () => { await writeFile(join(f.directory, "partial"), "fixture"); throw new AnalysisError("CHALLENGE_REQUIRED"); });
    await expect(downloadAnalysisSource({ ...f.input, cookies: ".douyin.com\tTRUE\t/\tTRUE\t0\tsession\tfixture" }, async () => f.runtime)).rejects.toThrow("CHALLENGE_REQUIRED");
    expect(f.resolveDouyin).toHaveBeenCalledTimes(1); expect(await readdir(f.directory)).toEqual([]); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("revalidates browser metadata before starting a download", async () => {
    const f = await fixture(); f.resolveDouyin.mockResolvedValue({ ...metadata, duration: 181 });
    await expect(downloadAnalysisSource(f.input, async () => f.runtime)).rejects.toThrow("DURATION_LIMIT");
    expect(f.run).toHaveBeenCalledTimes(2); expect(await readdir(f.directory)).toEqual([]);
  });
});
