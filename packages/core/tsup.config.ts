import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // Watch rebuilds must not wipe dist: the running server imports
  // @lot-agent/core from here, and `clean` races with those loads (ENOENT).
  clean: !options.watch,
  sourcemap: true,
}));
