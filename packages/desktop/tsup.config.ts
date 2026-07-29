import { defineConfig } from "tsup";

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
