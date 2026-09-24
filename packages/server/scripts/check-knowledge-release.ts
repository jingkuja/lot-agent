import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (!process.argv.includes("--local")) throw new Error("Requires --local");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = await mkdtemp(resolve(tmpdir(), "lot-clean-release-"));
const { stdout } = await promisify(execFile)("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
for (const path of stdout.split("\0").filter(Boolean)) {
  if (path.startsWith("data/") || path.startsWith("tests/eval/results/") || path.startsWith(".env") || path === "config/local.json" || path.includes("node_modules/") || path.includes("/dist/")) continue;
  const destination = resolve(target, path); await mkdir(dirname(destination), { recursive: true }); await copyFile(resolve(root, path), destination);
}
const env: NodeJS.ProcessEnv = { CI: "1" };
for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "SHELL", "PNPM_HOME"]) if (process.env[name]) env[name] = process.env[name];
const run = (args: string[], log: string) => new Promise<void>((resolvePromise, reject) => {
  const output = createWriteStream(resolve(target, log));
  const child = spawn("pnpm", args, { cwd: target, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output); child.stderr.pipe(output); child.once("error", reject);
  child.once("close", (code) => { output.end(); code === 0 ? resolvePromise() : reject(new Error(`Clean release step failed: ${log}; exit ${code}; directory ${target}`)); });
});
await run(["install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", `${process.env.HOME}/Library/pnpm/store/v10`], "install.log");
console.log("Clean locked dependency install passed (offline cache, install scripts disabled)");
await run(["build"], "build.log"); console.log("Clean workspace build passed");
await run(["test"], "test.log"); console.log("Clean workspace tests passed");
await mkdir(resolve(root, "tests/eval/results"), { recursive: true });
await writeFile(resolve(root, "tests/eval/results/clean-release.json"), JSON.stringify({ finished: new Date().toISOString(), target, source: "current tracked + nonignored untracked files; no data, personal config or .env", lockedInstall: true, offline: true, installScripts: false, build: true, testSummary: (await readFile(resolve(target,"test.log"),"utf8")).replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((line) => /Test Files|Tests\s+\d+/.test(line)), node: process.version }, null, 2));
// Keep logs and the reviewable compiled snapshot for release review; no production deployment.
console.log(JSON.stringify({ report: "tests/eval/results/clean-release.json", snapshot: target }));
