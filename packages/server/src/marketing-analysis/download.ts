import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ANALYSIS_LIMITS, type AnalysisSource } from "@lot-agent/core/marketing-analysis";
import { AnalysisError, classifyDownloadError } from "./errors.js";
import { parseAnalysisSource, downloaderArgs, validateSourceMetadata } from "./source.js";
import { startAnalysisEgress } from "./egress.js";
import { isolatedMediaRunner, sandboxBrowserArgs, type MediaRunner } from "./sandbox.js";
import { analysisBrowserArgs, resolveDouyinBrowser } from "./douyin-browser.js";

/** Internal dependency injection for operator probes and opted-in local Workers.
 * HTTP tasks never choose a runtime; the default remains Linux isolation. */
export interface AnalysisDownloadRuntime {
  runner: MediaRunner;
  egress: { readonly bytes: number; readonly failure?: string; close(): Promise<void> };
  resolveDouyin?: (source: AnalysisSource, signal: AbortSignal) => Promise<Record<string, unknown>>;
}

/** Server-owned private task directory; not reachable via any static mount. */
export async function downloadAnalysisSource(input: { shareText: string; directory: string; bridgePath: string; expectedDownloaderVersion: string; signal: AbortSignal; cookies?: string },
  createRuntime?: (directory: string, signal: AbortSignal) => Promise<AnalysisDownloadRuntime>) {
  if (!createRuntime && process.platform !== "linux") throw new AnalysisError("SANDBOX_REQUIRED", 503);
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(input.expectedDownloaderVersion)) throw new AnalysisError("DOWNLOADER_VERSION_REQUIRED");
  const source = parseAnalysisSource(input.shareText);
  const directory = resolve(input.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length) throw new AnalysisError("DOWNLOAD_DIRECTORY_NOT_EMPTY");
  const runtime = await (createRuntime ?? (async (workDirectory, signal) => {
    const socketPath = join(tmpdir(), `lot-egress-${randomUUID()}.sock`);
    const egress = await startAnalysisEgress(socketPath, { signal, maxBytes: ANALYSIS_LIMITS.downloadBytes, maxConnections: 64 });
    const bridge = { path: resolve(input.bridgePath), socket: socketPath };
    return { egress, runner: isolatedMediaRunner(workDirectory, bridge),
      resolveDouyin: (source: AnalysisSource, signal: AbortSignal) => resolveDouyinBrowser(source, signal, async () => {
        try { await access("/usr/bin/chromium", constants.X_OK); } catch { throw new AnalysisError("BROWSER_UNAVAILABLE", 503); }
        return { command: "/usr/bin/bwrap", args: sandboxBrowserArgs(bridge, analysisBrowserArgs("/tmp/profile")), env: { PATH: "/usr/bin:/bin" } };
      }) };
  }))(directory, input.signal);
  const { egress, runner } = runtime;
  try {
    if (input.cookies) await writeFile(join(directory, "cookies.txt"), validateCookieFile(input.cookies, source), { mode: 0o600, flag: "wx" });
    const version = (await runner.run("yt-dlp", ["--ignore-config", "--no-plugin-dirs", "--version"], input.signal)).stdout.trim();
    if (version !== input.expectedDownloaderVersion) throw new AnalysisError("DOWNLOADER_VERSION_INVALID");
    let metadata: Record<string, unknown>, browserSource = false;
    try { metadata = JSON.parse((await runner.run("yt-dlp", downloaderArgs(source, "metadata", !!input.cookies), input.signal)).stdout); }
    catch (error) {
      const code = classifyDownloadError(String((error as { diagnostic?: string }).diagnostic ?? ""));
      if (source.platform !== "douyin" || !runtime.resolveDouyin || input.signal.aborted || egress.failure
        || !(error instanceof AnalysisError) || error.code !== "MEDIA_PROCESS_FAILED"
        || !["PLATFORM_SESSION_REQUIRED", "PLATFORM_ACCESS_DENIED"].includes(code)) throw error;
      metadata = await runtime.resolveDouyin(source, input.signal); browserSource = true;
    }
    const resolved = validateSourceMetadata(metadata, source);
    if (browserSource) await writeFile(join(directory, "browser-source.json"), JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
    const downloaded = await runner.run("yt-dlp", downloaderArgs(resolved, "download", !!input.cookies, browserSource), input.signal);
    // Metadata can change between resolve and download; revalidate both.
    const final = validateSourceMetadata(JSON.parse(downloaded.stdout), resolved);
    const files = (await readdir(directory)).filter(name => /^source\.(?:mp4|webm|mkv)$/.test(name));
    if (files.length !== 1) throw new AnalysisError("UNSUPPORTED_SOURCE");
    const path = join(directory, files[0]); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > ANALYSIS_LIMITS.downloadBytes) throw new AnalysisError("DOWNLOAD_LIMIT");
    const hash = createHash("sha256");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false, signal: input.signal })) hash.update(chunk); }
    finally { await handle.close(); }
    const result: AnalysisSource = { ...final, sourceHash: hash.digest("hex"), mediaKey: files[0], downloaderVersion: version };
    return { source: result, bytes: info.size, transferredBytes: egress.bytes };
  } catch (error) {
    for (const file of await readdir(directory)) await rm(join(directory, file), { recursive: true, force: true });
    if (egress.failure) throw new AnalysisError(egress.failure);
    if (error instanceof AnalysisError && error.code !== "MEDIA_PROCESS_FAILED") throw error;
    if (input.signal.aborted) throw new AnalysisError("PROCESS_CANCELLED");
    throw new AnalysisError(classifyDownloadError(String((error as { diagnostic?: string }).diagnostic ?? "")));
  } finally {
    await rm(join(directory, "cookies.txt"), { force: true });
    await rm(join(directory, "browser-source.json"), { force: true });
    await egress.close();
  }
}

/** Only the task owner's supplied platform cookies enter the sandbox. No
 * browser profile import, cross-platform credentials or shared session path. */
export function validateCookieFile(value: string, source: Pick<AnalysisSource, "platform">) {
  if (Buffer.byteLength(value) > 64 * 1024 || value.includes("\0")) throw new AnalysisError("INVALID_COOKIES");
  const domains = source.platform === "douyin" ? ["douyin.com", "iesdouyin.com"] : source.platform === "bilibili" ? ["bilibili.com"] : ["xiaohongshu.com", "xhslink.com"];
  const lines = value.split(/\r?\n/).filter(line => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")));
  if (!lines.length || lines.length > 200) throw new AnalysisError("INVALID_COOKIES");
  for (const line of lines) {
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    const host = fields[0].replace(/^\./, "");
    if (fields.length !== 7 || !domains.some(domain => host === domain || host.endsWith(`.${domain}`))
      || !["TRUE", "FALSE"].includes(fields[1]) || !fields[2].startsWith("/") || !["TRUE", "FALSE"].includes(fields[3]) || !/^\d+$/.test(fields[4])) throw new AnalysisError("INVALID_COOKIES");
  }
  return "# Netscape HTTP Cookie File\n" + lines.join("\n") + "\n";
}
