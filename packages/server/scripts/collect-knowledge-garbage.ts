import { KnowledgeRepository } from "../src/knowledge/repository.js";
import "../src/load-env.js";
import { fileURLToPath } from "node:url";
import { DB } from "../src/db/database.js";
import { collectKnowledgeGarbage } from "../src/knowledge/garbage-collector.js";
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
try {
  const hold = process.argv.find((arg) => arg.startsWith("--backup-hold-days="));
  if (hold) {
    const days = Number(hold.split("=")[1]); if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Invalid backup hold");
    console.log(await new KnowledgeRepository(db.pool).transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rag-gc-backup',0))");
      return (await client.query("INSERT INTO rag_backup_windows(retain_until) VALUES (now()+make_interval(days=>$1)) RETURNING id,retain_until", [days])).rows[0];
    }));
  } else console.log(await collectKnowledgeGarbage(db.pool, fileURLToPath(new URL("../../../data/knowledge", import.meta.url)), { retentionDays: Number(process.env.KNOWLEDGE_RETENTION_DAYS ?? 30), apply: process.argv.includes("--apply") }));
} finally { await db.close(); }
