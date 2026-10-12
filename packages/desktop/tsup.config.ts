import { defineConfig } from "tsup";
import { createPublicKey } from "node:crypto";
import { DEFAULT_SERVER_URL, normalizeServerUrl } from "./src/main/config-store.js";

const serverUrl = normalizeServerUrl(process.env.LOT_DESKTOP_DEFAULT_SERVER_URL ?? DEFAULT_SERVER_URL);
const updatePublicKey = process.env.LOT_DESKTOP_UPDATE_PUBLIC_KEY
  ? createPublicKey(process.env.LOT_DESKTOP_UPDATE_PUBLIC_KEY).export({ type: "spki", format: "pem" }).toString()
  : "";

// Main process runs as ESM (Electron ≥ 28); the preload script must stay CJS
// because sandboxed preloads can't use ESM — hence the `.cjs` extension.
export default defineConfig([
  {
    entry: { index: "src/main/index.ts" },
    outDir: "dist/main",
    format: ["esm"],
    platform: "node",
    target: "node20",
    external: ["electron", "electron-updater"],
    define: {
      "process.env.LOT_DESKTOP_DEFAULT_SERVER_URL": JSON.stringify(serverUrl),
      "process.env.LOT_DESKTOP_UPDATE_URL": JSON.stringify(process.env.LOT_DESKTOP_UPDATE_URL ?? ""),
      "process.env.LOT_DESKTOP_UPDATE_PUBLIC_KEY": JSON.stringify(updatePublicKey),
    },
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
