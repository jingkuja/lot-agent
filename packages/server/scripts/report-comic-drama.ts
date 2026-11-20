import { Pool } from "pg";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { queryComicDramaReport } from "../src/comic-drama/operations-report.js";

const database = process.env.COMIC_DRAMA_REPORT_DATABASE_URL;
const hours = Number(process.argv[2] ?? 24);
if (!database || !Number.isSafeInteger(hours) || hours < 1 || hours > 720) {
  throw new Error("Configure COMIC_DRAMA_REPORT_DATABASE_URL and pass a bounded window in hours (1–720)");
}
const pool = new Pool({ connectionString: database, max: 1, statement_timeout: 25_000 });

async function temporary(root: string, pattern: RegExp) {
  let bytes = 0;
  async function size(path: string): Promise<void> {
    const stat = await lstat(path).catch(() => null);
    if (stat?.isDirectory()) for (const name of await readdir(path).catch(() => [])) await size(join(path, name));
    else if (stat?.isFile()) bytes += stat.size;
  }
  const dirs = (await readdir(root).catch(() => [])).filter(name => pattern.test(name));
  for (const name of dirs) await size(join(root, name));
  return { directories: dirs.length, bytes };
}

try {
  const report = await queryComicDramaReport(pool, hours);
  const root = process.env.COMIC_DRAMA_REPORT_MEDIA_ROOT || fileURLToPath(new URL("../../../data/comic-drama", import.meta.url));
  const temp = await Promise.all([temporary(root, /^\.(upload|frame|render)-/), temporary(tmpdir(), /^lot-comic-render-/)]);
  console.log(JSON.stringify({
    hours, ...report,
    temporary: { uploads: temp[0], renders: temp[1] },
    settlement: "Compare gateway receipts with actual bills; local totals are estimates.",
  }, null, 2));
} catch {
  console.error("Comic drama report unavailable. Check database access and migration version.");
  process.exitCode = 1;
} finally { await pool.end(); }
