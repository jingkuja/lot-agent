import { constants } from "node:fs";
import { lstat, readdir, realpath, open, access, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validLocalInput, type LocalToolResult, type LocalToolRequest } from "../../../core/src/desktop/protocol.js";

const MAX_BYTES = 1024 * 1024;
const output = (content: string): LocalToolResult => ({ content: content.length > 50000 ? content.slice(0, 50000) + "\n[output truncated]" : content });
const denied = (content: string): LocalToolResult => ({ content, isError: true, errorKind: "permission" });

/** Reject traversal, symlink components, alternate Windows streams and hard links.
 * No untrusted renderer/model can select the root; only the native picker can. */
export async function localPath(root: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || (process.platform === "win32" && /[:]/.test(input))) throw new Error("Use a relative workspace path");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error("Workspace changed; select it again");
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (isAbsolute(input) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path is outside the selected directory");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error("Symbolic and hard links are not supported");
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("Only regular files and directories are supported");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

async function readText(target: string): Promise<string> {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_BYTES) throw new Error("Only regular text files up to 1 MB are supported");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES || buffer.subarray(0, bytesRead).includes(0)) throw new Error("File is too large or binary");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

export async function findBash(): Promise<string | null> {
  const candidates = process.platform === "win32"
    ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe")]
    : ["/bin/bash", "/usr/bin/bash"];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next installed shell. */ }
  }
  return null;
}

async function bash(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<LocalToolResult> {
  const executable = await findBash();
  if (!executable) return denied("Bash is not installed. On Windows install Git for Windows and restart the app.");
  signal.throwIfAborted();
  // Do not copy model/API credentials or shell startup injection variables.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
  return new Promise(resolveResult => {
    const child = spawn(executable, ["--noprofile", "--norc", "-c", command], { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
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
      stopped = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => child.kill());
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
    child.on("error", () => finish({ content: "Bash could not start", isError: true, errorKind: "not_found" }));
    child.on("close", code => finish({ ...output(`${content}\n[exit: ${code ?? "terminated"}]${stopped ? "\nStopped: cancelled, timed out or output limit reached. Verify effects before repeating." : ""}`), isError: stopped || code !== 0, ...(stopped ? { errorKind: "unknown_outcome" as const } : {}) }));
  });
}

export async function executeLocalTool(root: string, request: LocalToolRequest, signal: AbortSignal,
  approve: (detail: string, signal: AbortSignal) => Promise<boolean>): Promise<LocalToolResult> {
  if (!validLocalInput(request.name, request.input)) return { content: "Invalid local tool input", isError: true, errorKind: "validation" };
  const input = request.input;
  let attemptedWrite = false;
  try {
    signal.throwIfAborted();
    if (request.name === "desktop_bash") {
      if (!await approve(`Bash\n${root}\n\n${input.command}`, signal)) return denied("User declined the command");
      signal.throwIfAborted();
      await localPath(root, ".");
      return await bash(input.command as string, root, Number(input.timeoutMs ?? 30000), signal);
    }
    const path = String(input.path ?? ".");
    const target = await localPath(root, path);
    if (request.name === "desktop_list_files") {
      const entries = await readdir(target, { withFileTypes: true });
      signal.throwIfAborted();
      return output(entries.slice(0, 2000).map(entry => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " [link: unavailable]" : ""}`).sort().join("\n") || "(empty directory)");
    }
    if (request.name === "desktop_read_file") return output(await readText(target));
    const original = request.name === "desktop_edit_file" ? await readText(target) : null;
    let content = String(input.content ?? "");
    if (original !== null) {
      const oldText = String(input.oldText);
      const index = original.indexOf(oldText);
      if (index < 0 || original.indexOf(oldText, index + 1) >= 0) return { content: "oldText must match exactly once. Read the current file before editing.", isError: true, errorKind: "validation" };
      content = original.slice(0, index) + String(input.newText) + original.slice(index + oldText.length);
    }
    if (Buffer.byteLength(content) > MAX_BYTES) return { content: "File exceeds 1 MB", isError: true, errorKind: "validation" };
    const detail = original === null ? `${path}\n\n${content}` : `${path}\n\n---\n${input.oldText}\n+++\n${input.newText}`;
    if (!await approve(detail, signal)) return denied("User declined the file change");
    signal.throwIfAborted();
    await localPath(root, path);
    if (original === null) {
      const handle = await open(target, "wx", 0o600);
      attemptedWrite = true;
      try { await handle.writeFile(content, { encoding: "utf8", signal }); } finally { await handle.close(); }
    } else {
      // Recheck after the native approval: never silently clobber external edits.
      if (await readText(target) !== original) return { content: "File changed while awaiting approval; read it again", isError: true, errorKind: "validation" };
      const mode = (await lstat(target)).mode;
      const temp = join(dirname(target), `.lot-edit-${randomUUID()}`);
      try {
        const handle = await open(temp, "wx", mode);
        try { await handle.writeFile(content, { encoding: "utf8", signal }); } finally { await handle.close(); }
        signal.throwIfAborted();
        await localPath(root, path);
        if (await readText(target) !== original) throw new Error("File changed before saving");
        attemptedWrite = true;
        await rename(temp, target);
      } finally { await unlink(temp).catch(() => {}); }
    }
    return output(`${request.name === "desktop_edit_file" ? "Edited" : "Created"} ${path} (${Buffer.byteLength(content)} bytes)`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { content: signal.aborted ? "Operation cancelled; verify file contents before repeating" : error instanceof Error ? error.message : "Local operation failed", isError: true,
      errorKind: signal.aborted || attemptedWrite ? "unknown_outcome" : code === "ENOENT" ? "not_found" : code === "EEXIST" ? "validation" : "permission" };
  }
}
