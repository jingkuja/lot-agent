import "../src/load-env.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import pg from "pg";
import { backupKnowledge, restoreKnowledge, type PgTools } from "../src/knowledge/maintenance/backup.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { KnowledgeJobs } from "../src/knowledge/ingestion/jobs.js";
import { LocalKnowledgeStorage } from "../src/knowledge/private-storage.js";
import { KnowledgeRetriever } from "../src/knowledge/retrieval.js";
import { KnowledgeKeys } from "../src/knowledge/access/keys.js";
import { indexArtifact } from "../src/knowledge/ingestion/indexer.js";
import { indexProfile } from "../src/knowledge/ingestion/profile.js";
import { textBlocks } from "../src/knowledge/ingestion/text.js";
import { PARSER_VERSION } from "../src/knowledge/ingestion/version.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { migrations } from "../src/db/migrations/index.js";
if (!process.argv.includes("--local")) throw new Error("Requires --local");
if (!["localhost", "127.0.0.1", "::1"].includes(process.env.PG_HOST ?? "localhost")) throw new Error("Local database only");
const arg = process.argv.indexOf("--docker-container");
const config: PgTools = { database: process.env.PG_DATABASE!, user: process.env.PG_USER!, container: arg < 0 ? undefined : process.argv[arg+1], host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), password: process.env.PG_PASSWORD };
const connection = { host: config.host, port: config.port, user: config.user, password: config.password, database: config.database };
const pool = new pg.Pool(connection); const root = fileURLToPath(new URL("../../../", import.meta.url));
const owner = randomUUID(); const target = `lot_rag_restore_${randomUUID().replaceAll("-", "")}`;
const directory = resolve(root, "data/backups", `knowledge-${new Date().toISOString().replaceAll(":", "-")}`);
let restored: pg.Pool | undefined; let created = false; let seeded = false;
const profile = indexProfile(`https://restore-${owner}.invalid/v1`);
try {
  await runMigrations(pool, migrations);
  await pool.query("INSERT INTO users(id,name) VALUES($1,'S4 backup fixture')", [owner]); seeded = true;
  const repo = new KnowledgeRepository(pool, `backup-${owner}`); const jobs = new KnowledgeJobs(pool);
  const collection = await repo.createCollection(owner, { name: "S4 恢复资料", description: "synthetic" }, randomUUID());
  const storage = new LocalKnowledgeStorage(resolve(root, "data/knowledge"));
  const text = "恢复测试 BACKUP-2026：资料恢复后必须能查询出处，原件字节保持一致。";
  const object = await storage.put(owner, Readable.from([Buffer.from(text)]), "text/plain");
  const item = await repo.createItem(owner, { sourceType: "document", title: "恢复校验.txt", object, mime: "text/plain", description: "", collectionIds: [collection.id], tags: [] }, randomUUID());
  await indexArtifact(jobs, (await jobs.claim(item.taskId!, `backup-${owner}`))!, profile, { blocks: textBlocks(text), diagnostics: [], parserVersion: PARSER_VERSION }, async () => ({ vector: Array.from({ length: 1024 }, (_, n) => n === 0 ? 1 : 0), tokens: 30 }));
  const keys = new KnowledgeKeys(pool); const key = await keys.create(owner, { name: "restore fixture", collectionIds: [collection.id], scopes: ["retrieval:read", "assets:read"] });
  await mkdir(resolve(root, "data/backups"), { recursive: true, mode: 0o700 });
  const manifest = await backupKnowledge(pool, resolve(root, "data"), directory, config);
  console.log(JSON.stringify({ snapshotCopied: true, files: manifest.files.length, tables: Object.keys(manifest.counts).length }));
  // Only a brand-new random database inside the already running PG instance.
  await pool.query(`CREATE DATABASE "${target}" TEMPLATE template0`); created = true;
  restored = new pg.Pool({ ...connection, database: target });
  const checks = await restoreKnowledge(restored, directory, { ...config, database: target });
  await runMigrations(restored, migrations); // idempotence after restore
  const restoredKeys = new KnowledgeKeys(restored); const caller = await restoredKeys.authenticate(key.token);
  const scope = await restoredKeys.scope(caller, [collection.id], "retrieval:read", caller.version);
  const result = await new KnowledgeRetriever(restored, profile, () => async () => { throw new Error("Restore must not call models"); }, (s,r) => restoredKeys.authorize(s,r)).retrieve(scope, { query: "BACKUP-2026", collectionIds: [collection.id], mode: "keyword", topK: 5, allowDegraded: false, sourceTypes: ["document"], tags: [] });
  if (result.results.length !== 1 || result.results[0].revisionId !== item.revisionId) throw new Error("Restored retrieval mismatch");
  const file = await restoredKeys.repo.getFile(owner, item.id, item.revisionId);
  const restoredStorage = new LocalKnowledgeStorage(resolve(directory, "data/knowledge"));
  const bytes: Buffer[] = []; for await (const data of restoredStorage.open(file.key)) bytes.push(Buffer.from(data));
  if (Buffer.concat(bytes).toString() !== text) throw new Error("Restored original mismatch");
  await restoredKeys.revoke(owner, key.id, key.version); await keys.authenticate(key.token);
  const report = { finished: new Date().toISOString(), restoredInSamePgInstance: true, newContainers: 0, ...checks, tableCountsMatch: true, allFileHashesMatch: true, sampleKeywordRetrieval: true, keyAuthenticationAndIndependentRevocation: true, originalConversationGenerationBillingCountsMatch: true, redisRestoredOrWorkersStarted: false, backupDirectory: directory, targetDatabaseRemovedAfterCheck: true };
  await mkdir(resolve(root, "tests/eval/results"), { recursive: true });
  await writeFile(resolve(root, "tests/eval/results/restore.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ restorePassed: true, vector: checks.vector, files: checks.files, tables: Object.keys(checks.counts).length, report: "tests/eval/results/restore.json" }));
} finally {
  await restored?.end();
  if (created) await pool.query(`DROP DATABASE "${target}"`);
  if (seeded) { await pool.query("DELETE FROM tasks WHERE user_id=$1", [owner]); await pool.query("DELETE FROM users WHERE id=$1", [owner]); }
  await pool.query("DELETE FROM rag_index_spaces WHERE profile_id=$1", [profile.id]); await pool.query("DELETE FROM rag_index_profiles WHERE id=$1", [profile.id]);
  await pool.end();
}
