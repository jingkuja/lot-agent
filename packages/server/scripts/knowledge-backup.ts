import "../src/load-env.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { backupKnowledge, restoreKnowledge, verifyBackup, type PgTools } from "../src/knowledge/maintenance/backup.js";
const [mode, path] = process.argv.slice(2);
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i+1]; };
if (!["backup", "verify", "restore"].includes(mode) || !path) throw new Error("Usage: knowledge-backup.ts backup|verify|restore DIR [--docker-container postgres] [--target-db EMPTY_DB]");
const directory = resolve(path);
const source = process.env.PG_DATABASE!; const database = mode === "restore" ? option("--target-db") : source;
if (!database || mode === "restore" && database === source) throw new Error("Restore requires a distinct empty target database");
const config: PgTools = { container: option("--docker-container"), user: process.env.PG_USER!, database, host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), password: process.env.PG_PASSWORD };
if (mode === "verify") { const m = await verifyBackup(directory); console.log(JSON.stringify({ verified: true, files: m.files.length, tables: Object.keys(m.counts).length })); }
else {
  const pool = new pg.Pool({ host: config.host, port: config.port, user: config.user, password: config.password, database });
  try {
    if (mode === "backup") { const m = await backupKnowledge(pool, option("--data-root") ?? fileURLToPath(new URL("../../../data", import.meta.url)), directory, config); console.log(JSON.stringify({ backup: directory, files: m.files.length, tables: Object.keys(m.counts).length, createdAt: m.createdAt })); }
    else console.log(JSON.stringify(await restoreKnowledge(pool, directory, config)));
  } finally { await pool.end(); }
}
