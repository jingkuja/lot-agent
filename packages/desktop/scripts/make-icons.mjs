/**
 * Convert the supplied brand artwork without cropping or stretching it.
 * Run on macOS: pnpm --filter @lot-agent/desktop run icons
 * Generated PNGs are committed, so packaging on Windows needs no image tools.
 * electron-builder converts icon.png into native ICNS / ICO resources.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const source = path.join(outDir, "icon-source.jpg");
const icon = path.join(outDir, "icon.png");
const tray = path.join(outDir, "tray-icon.png");

if (process.platform !== "darwin") {
  throw new Error("Icon regeneration uses macOS sips. Use the committed build/*.png files to package on other platforms.");
}
function sips(args) {
  const result = spawnSync("sips", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "sips failed");
  return result.stdout;
}
fs.mkdirSync(outDir, { recursive: true });
const metadata = sips(["-g", "pixelWidth", "-g", "pixelHeight", source]);
const width = Number(metadata.match(/pixelWidth:\s*(\d+)/)?.[1]);
const height = Number(metadata.match(/pixelHeight:\s*(\d+)/)?.[1]);
if (!width || !height) throw new Error("Cannot read source artwork dimensions");
const side = String(Math.max(width, height));
// Keep the complete original composition on a white square canvas.
sips(["-s", "format", "png", "--padToHeightWidth", side, side, "--padColor", "FFFFFF", source, "--out", icon]);
sips(["--resampleHeightWidth", "1024", "1024", icon]);
sips(["--resampleHeightWidth", "32", "32", icon, "--out", tray]);
console.log("Brand icons written to", outDir);
