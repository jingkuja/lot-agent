import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, lstat, copyFile, chmod, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { Pool } from "pg";
export type PgTools = { container?: string; user: string; database: string; host?: string; port?: number; password?: string };
export type BackupManifest = { version: 1; createdAt: string; database: string; databaseSha256: string; counts: Record<string, number>; files: Array<{ path: string; sha256: string; bytes: number }>; knowledgeObjects: Array<{ key: string; sha256: string; bytes: number }>; migrations: number[] };
export const fileHash = async (path: string) => { const hash = createHash("sha256"); for await (const data of createReadStream(path)) hash.update(data); return hash.digest("hex"); };
const ident = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw new Error("Invalid SQL identifier"); return `"${name}"`; };
export async function tableCounts(pool: Pick<Pool, "query">) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) if (tablename !== "rag_backup_windows") counts[tablename] = Number((await pool.query(`SELECT count(*) AS n FROM ${ident(tablename)}`)).rows[0].n);
  return counts;
}
/** Credentials stay in the child environment, never in CLI args or logs. */
export async function pgTool(tool: "pg_dump" | "pg_restore", args: string[], config: PgTools, file: string) {
  const command = config.container ? "docker" : tool;
  const argv = config.container ? ["exec", "-i", config.container, tool, "--username", config.user, "--dbname", config.database, ...args] : ["--host", config.host ?? "localhost", "--port", String(config.port ?? 5432), "--username", config.user, "--dbname", config.database, ...args];
  const child = spawn(command, argv, { env: { ...process.env, ...(config.container ? {} : { PGPASSWORD: config.password ?? "" }) }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); // Error details may contain database/user names or data. Report only status.
  const done = new Promise<void>((resolve, reject) => { child.once("error", () => reject(new Error(`${tool} unavailable`))); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${tool} failed (${code})`))); });
  try {
    if (tool === "pg_dump") { child.stdin.end(); await Promise.all([done, pipeline(child.stdout, createWriteStream(file, { flags: "wx", mode: 0o600 }))]); }
    else { child.stdout.resume(); await Promise.all([done, pipeline(createReadStream(file), child.stdin)]); }
  } catch (error) { child.kill("SIGTERM"); throw error; }
}
function safePath(root: string, path: string) {
  const target = resolve(root, path); const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || !/^(assets|documents|uploads|knowledge)\//.test(path) || path.includes("\\")) throw new Error("Invalid backup path");
  return target;
}
export async function backupKnowledge(pool: Pool, dataRoot: string, destination: string, config: PgTools): Promise<BackupManifest> {
  await mkdir(destination, { mode: 0o700 }); await chmod(destination, 0o700);
  const guard = await pool.connect(); const hold = randomUUID(); let transaction = false;
  try {
    await guard.query("SELECT pg_advisory_lock(hashtextextended('rag-gc-backup',0))");
    await guard.query("INSERT INTO rag_backup_windows(id,retain_until) VALUES($1,now()+interval '24 hours')", [hold]);
    await guard.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    const snapshot = (await guard.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    const counts = await tableCounts(guard);
    const objects = (await guard.query("SELECT storage_key AS key,sha256,byte_size::float8 AS bytes FROM rag_objects ORDER BY storage_key")).rows;
    const migrations = (await guard.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
    const files: BackupManifest["files"] = [];
    const copy = async (path: string) => {
      const source = safePath(dataRoot, path); const stat = await lstat(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Backup requires regular files");
      const target = safePath(resolve(destination, "data"), path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const before = await fileHash(source); await copyFile(source, target); await chmod(target, 0o600);
      const after = await fileHash(target);
      if (before !== after || before !== await fileHash(source)) throw new Error("Source changed during backup; retry the snapshot");
      files.push({ path, sha256: after, bytes: stat.size });
    };
    const walk = async (path: string) => {
      const entries = await readdir(resolve(dataRoot, path), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
      for (const entry of entries) { if (entry.isSymbolicLink()) throw new Error("Symlinks are not included in backups"); if (entry.isDirectory()) await walk(`${path}/${entry.name}`); else await copy(`${path}/${entry.name}`); }
    };
    // Immutable private objects are selected from the SAME snapshot as pg_dump.
    for (const object of objects) { if (!/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(object.key)) throw new Error("Invalid private object key"); await copy(`knowledge/${object.key}`); if (files.at(-1)!.sha256 !== object.sha256 || files.at(-1)!.bytes !== object.bytes) throw new Error("Private original missing or corrupt"); }
    // Existing generated assets and uploads are also included; a concurrent mutation fails validation.
    for (const name of ["assets", "documents", "uploads"]) await walk(name);
    await pgTool("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--snapshot=${snapshot}`], config, resolve(destination, "database.dump"));
    const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), database: config.database, databaseSha256: await fileHash(resolve(destination, "database.dump")), counts, files, knowledgeObjects: objects, migrations };
    await writeFile(resolve(destination, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await guard.query("COMMIT"); transaction = false;
    return manifest;
  } finally {
    if (transaction) await guard.query("ROLLBACK");
    await guard.query("DELETE FROM rag_backup_windows WHERE id=$1", [hold]);
    await guard.query("SELECT pg_advisory_unlock(hashtextextended('rag-gc-backup',0))"); guard.release();
  }
}
export async function verifyBackup(directory: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.databaseSha256) throw new Error("Invalid backup manifest");
  if (await fileHash(resolve(directory, "database.dump")) !== manifest.databaseSha256) throw new Error("Database backup checksum mismatch");
  for (const entry of manifest.files) if ((await lstat(safePath(resolve(directory, "data"), entry.path))).isSymbolicLink() || await fileHash(safePath(resolve(directory, "data"), entry.path)) !== entry.sha256) throw new Error("Backup object checksum mismatch");
  return manifest;
}
/** Restore ONLY into a newly created empty database. Never drops an existing database. */
export async function restoreKnowledge(pool: Pool, directory: string, config: PgTools) {
  const manifest = await verifyBackup(directory);
  if (Object.keys(await tableCounts(pool)).length) throw new Error("Restore target must be an empty database");
  await pgTool("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error"], config, resolve(directory, "database.dump"));
  const counts = await tableCounts(pool);
  if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) throw new Error("Restored table counts do not match snapshot");
  const vector = (await pool.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0]?.extversion;
  if (!vector) throw new Error("Restored vector extension missing");
  // No worker is started and no Redis connection is made. Pending outbox stays inert.
  return { counts, vector, files: manifest.files.length, privateObjects: manifest.knowledgeObjects.length, consumersStarted: false };
}
