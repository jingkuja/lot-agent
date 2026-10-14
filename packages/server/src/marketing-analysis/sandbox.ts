import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_LIMITS } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";

export type MediaCommand = "ffmpeg" | "ffprobe" | "yt-dlp";
export interface MediaRunner {
  run(command: MediaCommand, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }>;
}

/** Fixed, minimal filesystem and independent network/PID/IPC namespaces.
 * Never mount /, /app, a home directory, database secrets or the Docker socket. */
export function sandboxArgs(workDir: string, command: MediaCommand, args: string[], bridge?: { path: string; socket: string }): string[] {
  if (command === "yt-dlp" && !bridge) throw new AnalysisError("SANDBOX_REQUIRED", 503);
  const result = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc", "--ro-bind", "/etc/ssl", "/etc/ssl",
    "--bind", workDir, "/work", "--chdir", "/work", "--setenv", "PATH", "/usr/bin:/usr/local/bin", "--setenv", "LC_ALL", "C.UTF-8"];
  if (bridge) result.push("--ro-bind", bridge.path, "/bridge.py", "--ro-bind", bridge.socket, "/egress.sock");
  result.push("--", "/usr/bin/prlimit", "--cpu=240", "--as=2147483648", "--nofile=128", `--fsize=${ANALYSIS_LIMITS.downloadBytes}`, "--",
    ...(command === "yt-dlp" ? ["/usr/bin/python3", "-I", "/bridge.py", ...args] : [`/usr/bin/${command}`, ...args]));
  return result;
}

export function isolatedMediaRunner(workDir: string, bridge?: { path: string; socket: string }): MediaRunner {
  return {
    async run(command, args, signal) {
      if (process.platform !== "linux") throw new AnalysisError("SANDBOX_REQUIRED", 503);
      signal?.throwIfAborted();
      const argv = sandboxArgs(workDir, command, args, command === "yt-dlp" ? bridge : undefined);
      return new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/bwrap", argv, { shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
        let stdout = ""; let stderr = ""; let failure: string | undefined; let scanning = false;
        const kill = (code = "PROCESS_CANCELLED") => {
          failure ??= code;
          try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        const abort = () => kill();
        const timeout = setTimeout(() => kill("PROCESS_TIMEOUT"), 300000);
        const quota = setInterval(() => {
          if (scanning) return; scanning = true;
          void directoryBytes(workDir).then(size => { if (size > ANALYSIS_LIMITS.temporaryBytes) kill("TEMPORARY_LIMIT"); }).catch(() => kill("INVALID_PRIVATE_FILE")).finally(() => { scanning = false; });
        }, 250);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 8 * 1024 * 1024) kill("PROCESS_OUTPUT_LIMIT"); });
        child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 4 * 1024 * 1024) kill("PROCESS_OUTPUT_LIMIT"); });
        const cleanup = () => { clearTimeout(timeout); clearInterval(quota); signal?.removeEventListener("abort", abort); };
        child.once("error", () => { cleanup(); reject(new AnalysisError("SANDBOX_REQUIRED", 503)); });
        child.once("close", code => {
          cleanup();
          if (failure || code !== 0) {
            // Raw stderr stays internal to the caller for finite error classification.
            const error = new AnalysisError(failure ?? "MEDIA_PROCESS_FAILED");
            Object.defineProperty(error, "diagnostic", { value: stderr.slice(-4000), enumerable: false });
            reject(error);
          } else resolve({ stdout, stderr });
        });
      });
    },
  };
}

async function directoryBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile()) throw new AnalysisError("INVALID_PRIVATE_FILE");
    const info = await lstat(join(path, entry.name));
    if (!info.isFile() || info.isSymbolicLink()) throw new AnalysisError("INVALID_PRIVATE_FILE");
    bytes += info.size;
  }
  return bytes;
}
