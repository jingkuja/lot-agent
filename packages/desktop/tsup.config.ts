import { defineConfig } from "tsup";
import { DEFAULT_SERVER_URL, normalizeServerUrl } from "./src/main/config-store.js";

const serverUrl = normalizeServerUrl(process.env.LOT_DESKTOP_DEFAULT_SERVER_URL ?? DEFAULT_SERVER_URL);

// Main process runs as ESM (Electron ≥ 28); the preload script must stay CJS
// because sandboxed preloads can't use ESM — hence the `.cjs` extension.
export default defineConfig([
  {
    entry: { index: "src/main/index.ts" },
    outDir: "dist/main",
    format: ["esm"],
    platform: "node",
    target: "node20",
    external: ["electron"],
    define: { "process.env.LOT_DESKTOP_DEFAULT_SERVER_URL": JSON.stringify(serverUrl) },
    clean: true,
    sourcemap: true,
  },
  {
    entry: { index: "src/preload/index.ts" },
    outDir: "dist/preload",
    format: ["cjs"],
    platform: "node",
    target: "node20",
    external: ["electron"],
    sourcemap: true,
    outExtension: () => ({ js: ".cjs" }),
  },
]);
