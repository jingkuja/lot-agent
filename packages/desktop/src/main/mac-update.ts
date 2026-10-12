import path from "node:path";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);

export interface MacInstall { version: string; target: string; operation: string }

export function validateZipEntries(list: string): void {
  const names = list.split("\n").filter(Boolean);
  if (!names.length || names.length > 100000 || names.some(name => !name.startsWith("Lot Agent.app/") || name.includes("\\") || name.split("/").some(part => part === ".." || part === ".") || /[\x00-\x1f]/.test(name))) throw new Error("Invalid app archive");
}

async function checkTree(root: string, current = root): Promise<void> {
  for (const name of await readdir(current)) {
    const file = path.join(current, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(file);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("App symlink escapes bundle");
    } else if (info.isDirectory()) await checkTree(root, file);
    else if (!info.isFile()) throw new Error("Unexpected app file type");
  }
}

export async function readMacInstall(cache: string, target: string): Promise<MacInstall | null> {
  try {
    const item = JSON.parse(await readFile(path.join(cache, "install.json"), "utf8")) as MacInstall;
    if (item.target !== target || typeof item.operation !== "string" || path.dirname(item.operation) !== path.dirname(target) || !path.basename(item.operation).startsWith(".lot-update-")) return null;
    return item;
  } catch { return null; }
}

export async function prepareMacInstall(zip: string, target: string, version: string, cache: string, helperSource: string): Promise<MacInstall> {
  if (target.startsWith("/Volumes/") || !target.endsWith(".app") || (await realpath(target)) !== target) throw new Error("Install the app in a writable Applications directory first");
  await access(path.dirname(target), constants.W_OK);
  const { stdout: listing } = await exec("/usr/bin/zipinfo", ["-1", zip], { maxBuffer: 16 * 1024 ** 2, timeout: 30000 });
  validateZipEntries(listing);
  const operation = await mkdtemp(path.join(path.dirname(target), ".lot-update-"));
  try {
    const unpacked = path.join(operation, "unpacked");
    await mkdir(unpacked);
    await exec("/usr/bin/ditto", ["-x", "-k", zip, unpacked], { timeout: 120000 });
    const staged = path.join(unpacked, "Lot Agent.app");
    await checkTree(staged);
    const plist = path.join(staged, "Contents/Info.plist");
    const field = async (name: string) => (await exec("/usr/libexec/PlistBuddy", ["-c", `Print :${name}`, plist])).stdout.trim();
    if (await field("CFBundleIdentifier") !== "com.lotagent.desktop" || await field("CFBundleShortVersionString") !== version) throw new Error("App identity mismatch");
    const executable = await field("CFBundleExecutable");
    if (!/^[a-zA-Z0-9 ._-]+$/.test(executable)) throw new Error("Invalid executable");
    const binary = path.join(staged, "Contents/MacOS", executable);
    await access(binary, constants.X_OK);
    const { stdout: architectures } = await exec("/usr/bin/lipo", ["-archs", binary]);
    if (!architectures.trim().split(/\s+/).includes(process.arch === "x64" ? "x86_64" : "arm64")) throw new Error("App architecture mismatch");
    const helper = path.join(operation, "helper.sh");
    await copyFile(helperSource, helper);
    const install = { version, target, operation };
    await writeFile(path.join(cache, "install.json"), JSON.stringify(install), { mode: 0o600 });
    const child = spawn("/bin/bash", [helper, String(process.pid), target, staged, path.join(operation, "previous.app"), operation], { detached: true, stdio: "ignore", cwd: operation, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    for (let i = 0; i < 50; i++) {
      try { await access(path.join(operation, "helper-ready")); return install; } catch { await delay(100); }
    }
    child.kill();
    throw new Error("Update helper failed to start");
  } catch (error) {
    await rm(operation, { recursive: true, force: true });
    await rm(path.join(cache, "install.json"), { force: true });
    throw error;
  }
}
