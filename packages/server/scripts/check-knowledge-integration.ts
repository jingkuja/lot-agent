import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoEnv } from "../src/env-file.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const config = { ...process.env };
loadRepoEnv({ env: config });
if (!["localhost", "127.0.0.1", "::1"].includes(config.PG_HOST ?? "localhost")) throw new Error("Only the existing local test PostgreSQL instance is allowed");
if (!config.PG_DATABASE || !config.PG_PASSWORD) throw new Error("PG_DATABASE and PG_PASSWORD are required for the opt-in integration check");
const env = { ...process.env, RAG_INTEGRATION: "1" };
for (const key of ["PG_HOST", "PG_PORT", "PG_USER", "PG_PASSWORD", "PG_DATABASE"]) {
  if (config[key] !== undefined) (env as NodeJS.ProcessEnv)[key] = config[key];
}
// Forward only DB settings, never the rest of the developer's .env secrets.
const result = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "packages/server/src/knowledge/integration.test.ts"], { cwd: root, env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
