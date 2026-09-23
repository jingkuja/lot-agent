/** Opt-in destructive fixture check: only a dedicated local test database is accepted. */
import assert from "node:assert/strict";
import pg from "pg";
import { runMigrations } from "../src/db/migration-runner.js";
import { migrations } from "../src/db/migrations/index.js";

const raw = process.env.RAG_CHECK_DATABASE_URL;
if (!raw) throw new Error("Set RAG_CHECK_DATABASE_URL to a disposable local /rag_feasibility database");
const url = new URL(raw);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/rag_feasibility") {
  throw new Error("Only a disposable local database named rag_feasibility is allowed");
}
const pool = new pg.Pool({ connectionString: raw });
try {
  const existing = await pool.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(existing.rows[0].count, 0, "Database must be empty; this script never clears existing tables");
  await pool.query("CREATE EXTENSION vector");
  const version = await pool.query("SELECT extversion FROM pg_extension WHERE extname='vector'");
  // Full migration into an empty database, then repeated startup (no new DDL).
  await runMigrations(pool, migrations);
  await runMigrations(pool, migrations);
  const count = await pool.query("SELECT count(*)::int AS count FROM schema_migrations");
  assert.equal(count.rows[0].count, migrations.length);
  await pool.query("CREATE TABLE rag_probe (id int PRIMARY KEY, owner_id text NOT NULL, embedding vector(3), terms tsvector)");
  await pool.query("CREATE INDEX rag_probe_terms ON rag_probe USING gin(terms)");
  await pool.query(`INSERT INTO rag_probe VALUES
    (1, 'u1', '[1,0,0]', to_tsvector('simple', '产品 离线 使用 AB-123')),
    (2, 'u1', '[0,1,0]', to_tsvector('simple', '在线 模式')),
    (3, 'u2', '[1,0,0]', to_tsvector('simple', '产品 离线'))`);
  const nearest = await pool.query("SELECT id FROM rag_probe WHERE owner_id=$1 ORDER BY embedding <=> $2::vector, id", ["u1", "[1,0,0]"]);
  assert.deepEqual(nearest.rows.map((row) => row.id), [1, 2]);
  const keyword = await pool.query("SELECT id FROM rag_probe WHERE owner_id=$1 AND terms @@ plainto_tsquery('simple', $2)", ["u1", "离线"]);
  assert.deepEqual(keyword.rows.map((row) => row.id), [1]);
  await assert.rejects(pool.query("INSERT INTO rag_probe VALUES (4, 'u1', '[1,0]', null)"), /dimensions/);
  await pool.query("CREATE DATABASE rag_feasibility_upgrade");
  const upgradeUrl = new URL(raw);
  upgradeUrl.pathname = "/rag_feasibility_upgrade";
  const upgrade = new pg.Pool({ connectionString: upgradeUrl.toString() });
  try {
    await runMigrations(upgrade, migrations.filter((migration) => migration.version <= 20));
    const seeded = await upgrade.query("INSERT INTO conversations (title) VALUES ('RAG upgrade fixture') RETURNING id");
    await runMigrations(upgrade, migrations);
    await runMigrations(upgrade, migrations);
    const preserved = await upgrade.query("SELECT title FROM conversations WHERE id=$1", [seeded.rows[0].id]);
    assert.equal(preserved.rows[0].title, "RAG upgrade fixture");
    const upgraded = await upgrade.query("SELECT count(*)::int AS count FROM schema_migrations");
    assert.equal(upgraded.rows[0].count, migrations.length);
  } finally {
    await upgrade.end();
  }
  console.log(JSON.stringify({ postgres: (await pool.query("SHOW server_version")).rows[0].server_version,
    vector: version.rows[0].extversion, freshMigrations: count.rows[0].count,
    repeatedStartup: "passed", upgradeFrom20: "passed; conversation preserved", cosineOrder: nearest.rows, scopedKeyword: keyword.rows,
    dimensionMismatch: "rejected", note: "Pre-tokenized Chinese fixture only; tokenizer and real embedding are not validated" }, null, 2));
} finally {
  await pool.end();
}
