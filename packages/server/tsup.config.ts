import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["src/index.ts", "src/workers/index.ts", "src/workers/knowledge.ts", "src/workers/knowledge-parser.ts"],
  format: ["esm"],
  dts: true,
  clean: !options.watch,
  sourcemap: true,
}));
