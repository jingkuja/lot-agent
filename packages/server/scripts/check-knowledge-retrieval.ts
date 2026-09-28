import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { loadRepoEnv } from "../src/env-file.js";

// Isolate all deterministic SQL fixtures from the application's tables. No model calls.
const config = { ...process.env }; loadRepoEnv({ env: config });
if (!["localhost", "127.0.0.1", "::1"].includes(config.PG_HOST ?? "localhost")) throw new Error("Local PostgreSQL required");
const pool = new pg.Pool({ host: config.PG_HOST, port: Number(config.PG_PORT ?? 5432), user: config.PG_USER, password: config.PG_PASSWORD, database: config.PG_DATABASE });
const schema = `rag_retrieval_${randomUUID().replaceAll("-", "")}`;
const root = fileURLToPath(new URL("../../../", import.meta.url));
let created = false;
try {
  await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
  const env = { ...process.env, RAG_INTEGRATION: "1", PGOPTIONS: `-c search_path=${schema},public` };
  for (const key of ["PG_HOST", "PG_PORT", "PG_USER", "PG_PASSWORD", "PG_DATABASE"]) if (config[key] !== undefined) (env as NodeJS.ProcessEnv)[key] = config[key];
  // Profile-space tests perform DDL against the shared fixture schema; don't interleave that
  // DDL with other files' fixture inserts (foreign-key table locks can otherwise deadlock).
  const result = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--no-file-parallelism",
    "packages/server/src/knowledge/index.integration.test.ts", "packages/server/src/knowledge/access/integration.test.ts",
    "packages/server/src/knowledge/ingestion/profile-build.integration.test.ts", "packages/server/src/knowledge/profile/integration.test.ts",
    "packages/server/src/knowledge/retrieval-quality.integration.test.ts",
  ], { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try { if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await pool.end(); }
}
