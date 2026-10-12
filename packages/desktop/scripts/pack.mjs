import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2).filter(arg => arg !== "--");
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: pnpm dist:desktop[:mac|:win] [--server-url https://todoucloud.com] [electron-builder options]\nAlways builds current Core, Web and Electron before packaging. --server-url sets the bundled default.");
  process.exit(0);
}
let serverUrl = process.env.LOT_DESKTOP_DEFAULT_SERVER_URL ?? "https://todoucloud.com";
let supplied = false;
const builderArgs = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--server-url" || arg.startsWith("--server-url=")) {
    if (supplied) throw new Error("--server-url must be specified only once");
    supplied = true;
    serverUrl = arg === "--server-url" ? args[++i] : arg.slice("--server-url=".length);
    if (!serverUrl || serverUrl.startsWith("--")) throw new Error("--server-url requires a URL");
  } else builderArgs.push(arg);
}
// Fail before running any builds; tsup also validates the complete URL policy.
let normalized;
try { normalized = new URL(serverUrl.includes("://") ? serverUrl : `http://${serverUrl}`); }
catch { throw new Error("--server-url must be a valid HTTP(S) origin"); }
if (!["https:", "http:"].includes(normalized.protocol) || normalized.username || normalized.password || normalized.search || normalized.hash || normalized.pathname !== "/") throw new Error("--server-url must be an HTTP(S) origin without credentials, paths or query parameters");
const env = { ...process.env, LOT_DESKTOP_DEFAULT_SERVER_URL: normalized.origin };
console.log(`Packaging current Web UI with default server ${normalized.origin}`);
function pnpm(arguments_, cwd) {
  // npm_execpath points at pnpm's JS entry on every platform, avoiding cmd.exe
  // quoting and shell interpolation of a supplied server URL on Windows.
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error("Run this script with pnpm run dist (or pnpm dist:desktop).");
  const result = spawnSync(process.execPath, [cli, ...arguments_], { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
pnpm(["--filter", "@lot-agent/core", "run", "build"], root);
pnpm(["--filter", "@lot-agent/web", "run", "build"], root);
pnpm(["run", "build"], desktopDir);
pnpm(["exec", "electron-builder", ...builderArgs], desktopDir);
