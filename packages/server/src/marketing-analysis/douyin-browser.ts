import { spawn } from "node:child_process";
import { mkdtemp, readdir, lstat, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { createDeadline, withAbort } from "@lot-agent/core";
import type { AnalysisSource } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import { BrowserPipe } from "./browser-pipe.js";
import { parseAnalysisSource, validateSourceMetadata } from "./source.js";

export interface BrowserLaunch { command: string; args: string[]; env: Record<string, string>; }

/** Always used inside the OS sandbox. The browser profile is new for each task;
 * only the parent-owned HTTPS proxy can access the network. */
export function analysisBrowserArgs(profile: string, proxyPort = 3189): string[] {
  return ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-breakpad", "--disable-crash-reporter", "--disable-crashpad-for-testing",
    "--disable-default-apps", "--disable-client-side-phishing-detection", "--disable-component-extensions-with-background-pages",
    "--disable-features=NetworkTimeServiceQuerying,AimEnabled,OptimizationHints,OptimizationGuideModelDownloading,AutofillServerCommunication,MediaRouter,DialMediaRouteProvider,AvoidCorsURLLoaderRestartOnRedirect",
    "--no-first-run", "--no-default-browser-check", "--no-service-autorun", "--password-store=basic", "--use-mock-keychain",
    "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--renderer-process-limit=2", "--js-flags=--max-old-space-size=128",
    "--remote-debugging-pipe", `--user-data-dir=${profile}`, `--crash-dumps-dir=${profile}/crashes`,
    // Plain HTTP has no permitted listener; browser background probes must not
    // consume or contaminate the task's HTTPS-only egress.
    `--proxy-server=http=127.0.0.1:9;https=127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "about:blank"];
}

/** Only accept the requested video's public, muxed player URL. Never copy
 * arbitrary page JSON into yt-dlp's executable/configuration options. */
export function douyinBrowserMetadata(raw: unknown, source: AnalysisSource): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || source.platform !== "douyin") throw new AnalysisError("UNSUPPORTED_SOURCE");
  const value = raw as Record<string, any>;
  if (typeof value.pageUrl !== "string" || !Array.isArray(value.videos)) return undefined;
  let resolved: AnalysisSource;
  try { resolved = parseAnalysisSource(value.pageUrl); } catch { return undefined; }
  if (resolved.platform !== "douyin" || !resolved.canonicalId) return undefined;
  if (source.canonicalId && source.canonicalId !== resolved.canonicalId) throw new AnalysisError("UNSUPPORTED_SOURCE");
  for (const video of value.videos.slice(0, 5)) {
    if (!video || typeof video.url !== "string" || video.url.length > 8192) continue;
    let url: URL;
    try { url = new URL(video.url); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || !url.hostname.endsWith(".douyinvod.com") || url.searchParams.get("__vid") !== resolved.canonicalId) continue;
    if (typeof video.duration !== "number" || !Number.isFinite(video.duration) || video.duration <= 0) continue;
    if (![video.width, video.height].every(n => Number.isInteger(n) && n > 0 && n <= 1920)) throw new AnalysisError("UNSUPPORTED_SOURCE");
    if (typeof value.userAgent !== "string" || value.userAgent.length > 1024 || /[\r\n]/.test(value.userAgent)) throw new AnalysisError("UNSUPPORTED_SOURCE");
    const metadata = { id: resolved.canonicalId, webpage_url: resolved.canonicalUrl, title: String(value.title ?? "").slice(0, 500),
      duration: video.duration, width: video.width, height: video.height, url: url.href, ext: "mp4", protocol: "https",
      extractor: "generic", extractor_key: "Generic", http_headers: { "User-Agent": value.userAgent, Referer: resolved.canonicalUrl } };
    validateSourceMetadata(metadata, source);
    return metadata;
  }
  return undefined;
}

// DOM only: login promotion text is not an authorization decision. A close
// control is used only inside the login panel, never to complete verification.
const readPlayer = `(() => {
  for (const panel of document.querySelectorAll('[role="dialog"], #douyin_login_comp_flat_panel')) {
    if (!/扫码登录|验证码登录/.test(panel.textContent || '')) continue;
    const close = panel.querySelector('[aria-label="关闭"], [aria-label="Close"], [title="关闭"]');
    if (close instanceof HTMLElement) close.click();
  }
  const videos = Array.from(document.querySelectorAll('video')).slice(0, 5).filter(video => {
    const box = video.getBoundingClientRect(); return box.width > 0 && box.height > 0;
  }).map(video => {
    video.muted = true;
    if (video.paused && !Number.isFinite(video.duration)) video.play().catch(() => {});
    const result = { url: video.currentSrc, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    if (video.readyState >= 1) video.pause();
    return result;
  });
  return { pageUrl: location.href, title: document.title.slice(0, 500), userAgent: navigator.userAgent, videos,
    challenge: /请完成验证|拖动滑块|安全验证|Verify you are human/i.test((document.body?.innerText || '').slice(0, 12000)) };
})()`;

export async function resolveDouyinBrowser(source: AnalysisSource, signal: AbortSignal,
  launch: (scratch: string) => Promise<BrowserLaunch>): Promise<Record<string, unknown>> {
  if (source.platform !== "douyin") throw new AnalysisError("UNSUPPORTED_SOURCE");
  signal.throwIfAborted();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "lot-browser-")));
  const deadline = createDeadline(45_000, signal);
  try {
    const options = await launch(scratch);
    deadline.signal.throwIfAborted();
    const child = spawn(options.command, options.args, { cwd: scratch, env: options.env, shell: false, detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    const pipe = new BrowserPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    let stderr = "", outputBytes = 0, checking = false;
    const stop = (error = new AnalysisError("BROWSER_READ_FAILED")) => {
      pipe.close(error);
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const exited = new Promise<void>(resolve => child.once("close", (code, exitSignal) => { stderr += `\nexit=${code}; signal=${exitSignal ?? "none"}`; resolve(); }));
    child.once("error", () => pipe.close(new AnalysisError("BROWSER_UNAVAILABLE", 503)));
    child.stdout?.on("data", chunk => { outputBytes += chunk.length; if (outputBytes > 4 * 1024 * 1024) stop(); });
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const abort = () => stop(new AnalysisError(signal.aborted ? "PROCESS_CANCELLED" : "BROWSER_READ_FAILED"));
    deadline.signal.addEventListener("abort", abort, { once: true });
    if (deadline.signal.aborted) abort();
    const quota = setInterval(() => {
      if (checking) return; checking = true;
      void browserScratchBytes(scratch).then(bytes => { if (bytes > 256 * 1024 * 1024) stop(new AnalysisError("TEMPORARY_LIMIT")); })
        .catch(() => stop()).finally(() => { checking = false; });
    }, 1000);
    try {
      const version = await pipe.send("Browser.getVersion");
      const { browserContextId } = await pipe.send("Target.createBrowserContext", { disposeOnDetach: true });
      const { targetId } = await pipe.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await pipe.send("Target.attachToTarget", { targetId, flatten: true });
      pipe.onEvent = message => {
        if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
        const { requestId, request, resourceType } = message.params;
        const allowed = typeof request?.url === "string" && request.url.startsWith("https://") && !["Image", "Font", "Ping"].includes(resourceType);
        void pipe.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
      };
      await pipe.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
      await pipe.send("Emulation.setUserAgentOverride", { userAgent: String(version.userAgent).replace("HeadlessChrome", "Chrome") }, sessionId);
      await pipe.send("Page.navigate", { url: source.canonicalUrl }, sessionId);
      for (;;) {
        deadline.signal.throwIfAborted();
        pipe.throwIfClosed();
        // A redirect may destroy the execution context between polls.
        const result = await pipe.send("Runtime.evaluate", { expression: readPlayer, returnByValue: true }, sessionId).catch(() => undefined);
        pipe.throwIfClosed();
        const value = result?.result?.value;
        if (value) {
          const metadata = douyinBrowserMetadata(value, source);
          if (metadata) return metadata;
          if (value.challenge) throw new AnalysisError("CHALLENGE_REQUIRED");
        }
        let timer: ReturnType<typeof setTimeout>;
        try { await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, 250); }), deadline.signal); }
        finally { clearTimeout(timer!); }
      }
    } catch (error) {
      const failure = signal.aborted ? new AnalysisError("PROCESS_CANCELLED") : error instanceof AnalysisError ? error : new AnalysisError("BROWSER_READ_FAILED");
      Object.defineProperty(failure, "diagnostic", { value: stderr, enumerable: false });
      throw failure;
    } finally {
      clearInterval(quota); deadline.signal.removeEventListener("abort", abort); stop(); await exited;
    }
  } finally { deadline.dispose(); await rm(scratch, { recursive: true, force: true }); }
}

async function browserScratchBytes(directory: string): Promise<number> {
  let bytes = 0, entries = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 4096) throw new AnalysisError("TEMPORARY_LIMIT");
      const file = join(path, entry.name);
      // Chromium creates transient profile locks and sockets. Never follow links.
      try {
        const info = await lstat(file);
        if (info.isDirectory() && !info.isSymbolicLink()) await visit(file);
        else if (info.isFile()) bytes += info.size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  };
  await visit(directory); return bytes;
}
