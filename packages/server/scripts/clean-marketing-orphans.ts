import "../src/load-env.js";
import { fileURLToPath } from "node:url";
import { DB } from "../src/db/database.js";
import { collectMarketingOrphans } from "../src/marketing-video/orphans.js";

// One-off cleanup (P20): lists what drafts deleted before round 6 left behind; --apply deletes it.
// Run with the same data folder as the server, e.g. pnpm marketing-video:clean-orphans -- --apply
const dataRoot = process.argv.find(arg => arg.startsWith("--data-root="))?.split("=")[1] ?? fileURLToPath(new URL("../../../data", import.meta.url));
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
try { console.log({ dataRoot, ...await collectMarketingOrphans(db.pool, dataRoot, process.argv.includes("--apply")) }); }
finally { await db.close(); }
