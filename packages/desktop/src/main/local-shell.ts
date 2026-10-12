import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { win32 } from "node:path";
import type { LocalShell, LocalToolResult } from "../../../core/src/desktop/protocol.js";

export function shellCandidates(kind: LocalShell, platform = process.platform, env = process.env): string[] {
  if (platform === "win32") {
    // Use the system executable, never a PATH entry or a user-installed Git/WSL shell.
    return kind === "powershell"
      ? [win32.join(env.SYSTEMROOT ?? env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
      : [];
  }
  return kind === "bash" ? ["/bin/bash", "/usr/bin/bash"] : [];
}

export async function findLocalShell(): Promise<{ kind: LocalShell; executable: string } | null> {
  const kind = process.platform === "win32" ? "powershell" : "bash";
  for (const executable of shellCandidates(kind)) {
    try { await access(executable, constants.X_OK); return { kind, executable }; } catch { /* Fail closed if unavailable. */ }
  }
  return null;
}

export function shellArguments(kind: LocalShell, command: string): string[] {
  if (kind === "bash") return ["--noprofile", "--norc", "-c", command];
  // UTF-16LE encoded command avoids Windows command-line quoting and locale loss.
  // The schema limits PowerShell input to 10000 chars to stay below CreateProcess's limit.
  const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n$OutputEncoding = [Console]::OutputEncoding\n$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\n& {\n${command}\n}\n$lotCommandSucceeded = $?\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $lotCommandSucceeded) { exit 1 }`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export async function executeShell(kind: LocalShell, command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<LocalToolResult> {
  const shell = await findLocalShell();
  if (!shell || shell.kind !== kind) return { content: "Requested shell is unavailable on this computer. Use the advertised local file tools or update the desktop server.", isError: true, errorKind: "permission" };
  signal.throwIfAborted();
  // Do not inherit credentials or shell startup injection variables.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  return new Promise(resolveResult => {
    const child = spawn(shell.executable, shellArguments(kind, command), { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let content = "";
    let stopped = false;
    let settled = false;
    const finish = (result: LocalToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolveResult(result);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(win32.join(process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
        killer.on("close", code => { if (code !== 0) child.kill(); });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const append = (chunk: string) => {
      content += chunk;
      if (content.length > 50000) { content = content.slice(0, 50000); stop(); }
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    child.on("error", () => finish({ content: "Local shell could not start", isError: true, errorKind: "not_found" }));
    child.on("close", code => finish({ content: `${content}\n[exit: ${code ?? "terminated"}]${stopped ? "\nStopped: cancelled, timed out or output limit reached. Verify effects before repeating." : ""}`, isError: stopped || code !== 0, ...(stopped ? { errorKind: "unknown_outcome" as const } : {}) }));
  });
}
