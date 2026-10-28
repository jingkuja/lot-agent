import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { AnalysisError } from "./errors.js";

// Installed explicitly by setup:marketing-analysis:local; never downloaded by a task.
export function localDouyinDownloader(): string {
  // Works from both TypeScript sources and bundled dist chunks. Only the local
  // runner calls this; Linux images do not need the local setup script.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolve(directory, "deploy/yt-dlp/setup-local.py"))) {
      return resolve(directory, "data/media-tools/yt-dlp-douyin-2026.08.19");
    }
    const parent = dirname(directory);
    if (parent === directory) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
    directory = parent;
  }
}

/** Match the Linux bridge's normalized positional URLs, not arbitrary options. */
export function usesDouyinDownloader(args: string[]): boolean {
  if (args.length < 2 || args.at(-2) !== "--") return false;
  return /^https:\/\/(?:v\.douyin\.com\/[A-Za-z0-9_-]{3,80}|www\.douyin\.com\/video\/\d{5,30})$/.test(args.at(-1)!);
}
