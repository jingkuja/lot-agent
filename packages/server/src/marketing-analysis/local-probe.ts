import { spawn } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ANALYSIS_LIMITS } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import { startAnalysisEgress } from "./egress.js";
import type { AnalysisDownloadRuntime } from "./download.js";
import type { MediaRunner } from "./sandbox.js";

/** macOS isolation for operator probes and explicitly opted-in development Workers.
 * Never selected by production configuration or HTTP input.
 * Child processes cannot read app credentials/home or make direct requests. */
export function localProbePolicy(directory: string, proxyPort?: number) {
  if (proxyPort !== undefined && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) throw new AnalysisError("SANDBOX_REQUIRED", 503);
  return `(version 1)
(deny default)
(allow process* sysctl-read mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt/homebrew") (subpath "/Library/Apple") (subpath "/Library/Developer/CommandLineTools") (subpath "/private/etc/ssl") (subpath "/private/var/db/timezone") (literal "/private/etc/localtime") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath ${JSON.stringify(directory)}))
(allow file-write* (subpath ${JSON.stringify(directory)}) (literal "/dev/null"))
${proxyPort === undefined ? "" : `(allow network-outbound (remote ip "localhost:${proxyPort}"))`}`;
}

export function localProbeRunner(directory: string, proxyPort?: number): MediaRunner {
  return { async run(command, args, signal) {
    if (process.platform !== "darwin" || (command === "yt-dlp" && !proxyPort)) throw new AnalysisError("SANDBOX_REQUIRED", 503);
    signal?.throwIfAborted();
    const work = await realpath(directory);
    const binary = await realpath(`/opt/homebrew/bin/${command}`);
    const python = await realpath("/opt/homebrew/bin/python3");
    const argv = args.map(arg => arg.replaceAll("/work/", `${work}/`).replace("http://127.0.0.1:3189", `http://127.0.0.1:${proxyPort}`));
    const limits = "import os,resource,sys;resource.setrlimit(resource.RLIMIT_CPU,(240,240));resource.setrlimit(resource.RLIMIT_FSIZE,(104857600,104857600));resource.setrlimit(resource.RLIMIT_NOFILE,(128,128));os.execv(sys.argv[1],sys.argv[1:])";
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", localProbePolicy(work, command === "yt-dlp" ? proxyPort : undefined), python, "-I", "-c", limits, binary, ...argv],
        { cwd: work, shell: false, detached: true, env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", LC_ALL: "C", PYTHONDONTWRITEBYTECODE: "1", TMPDIR: work }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", failure: string | undefined, checking = false;
      const stop = (code: string) => { failure ??= code; try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
      const abort = () => stop("PROCESS_CANCELLED");
      const timeout = setTimeout(() => stop("PROCESS_TIMEOUT"), 300000);
      const quota = setInterval(() => {
        if (checking) return; checking = true;
        void (async () => {
          let bytes = 0;
          for (const name of await readdir(work)) {
            const info = await lstat(join(work, name));
            if (!info.isFile() || info.isSymbolicLink()) throw new Error("INVALID_PRIVATE_FILE");
            bytes += info.size;
          }
          if (bytes > ANALYSIS_LIMITS.temporaryBytes) stop("TEMPORARY_LIMIT");
        })().catch(() => stop("INVALID_PRIVATE_FILE")).finally(() => { checking = false; });
      }, 250);
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 8 * 1024 * 1024) stop("PROCESS_OUTPUT_LIMIT"); });
      child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 4 * 1024 * 1024) stop("PROCESS_OUTPUT_LIMIT"); });
      const cleanup = () => { clearTimeout(timeout); clearInterval(quota); signal?.removeEventListener("abort", abort); };
      child.once("error", () => { cleanup(); reject(new AnalysisError("SANDBOX_REQUIRED", 503)); });
      child.once("close", (code, exitSignal) => {
        cleanup();
        if (!failure && code === 0) return resolve({ stdout, stderr });
        const error = new AnalysisError(failure ?? "MEDIA_PROCESS_FAILED");
        Object.defineProperty(error, "diagnostic", { value: `exit=${code}; signal=${exitSignal ?? "none"}\n${stderr.slice(-4000)}`, enumerable: false });
        reject(error);
      });
    });
  } };
}

/** Child sees only a localhost proxy. The parent pins and validates every
 * destination via the same Unix-socket egress used by the Linux worker. */
export async function localProbeDownloadRuntime(directory: string, signal: AbortSignal): Promise<AnalysisDownloadRuntime> {
  if (process.platform !== "darwin") throw new AnalysisError("SANDBOX_REQUIRED", 503);
  const path = join(tmpdir(), `lot-egress-${randomUUID()}.sock`);
  const egress = await startAnalysisEgress(path, { signal, maxBytes: ANALYSIS_LIMITS.downloadBytes });
  const sockets = new Set<Socket>();
  const relay = createServer(client => {
    const peer = connect(path); sockets.add(client); sockets.add(peer);
    client.on("error", () => peer.destroy()); peer.on("error", () => client.destroy());
    client.once("close", () => { sockets.delete(client); peer.destroy(); });
    peer.once("close", () => { sockets.delete(peer); client.destroy(); });
    client.pipe(peer); peer.pipe(client);
  });
  try {
    await new Promise<void>((resolve, reject) => { relay.once("error", reject); relay.listen(0, "127.0.0.1", () => { relay.off("error", reject); resolve(); }); });
    const address = relay.address();
    if (!address || typeof address === "string") throw new AnalysisError("SANDBOX_REQUIRED", 503);
    return { runner: localProbeRunner(directory, address.port), egress: {
      get bytes() { return egress.bytes; }, get failure() { return egress.failure; },
      async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => relay.close(() => resolve())); await egress.close(); },
    } };
  } catch (error) { relay.close(); await egress.close(); throw error; }
}
