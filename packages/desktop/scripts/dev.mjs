import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(electron, [desktopDir, ...process.argv.slice(2)], {
  cwd: desktopDir,
  env: { ...process.env, LOT_DESKTOP_DEV: "1" },
  stdio: "inherit",
});

child.on("error", error => {
  console.error(`Failed to start Electron: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
