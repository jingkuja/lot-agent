import { Pool } from "pg";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const database = process.env.COMIC_DRAMA_REPORT_DATABASE_URL;
const hours = Number(process.argv[2] ?? 24);
if (!database || !Number.isSafeInteger(hours) || hours < 1 || hours > 720) {
  throw new Error("Configure COMIC_DRAMA_REPORT_DATABASE_URL and pass a bounded window in hours (1–720)");
}
const pool = new Pool({ connectionString: database, max: 1, statement_timeout: 25_000 });
const cutoff = "now()-make_interval(hours=>$1)";
const kinds = "('comic-drama.image','comic-drama.video','comic-drama.render','marketing.video','digital-presenter.video')";
const jobs = "lot_comic_drama.cd_generation_requests r JOIN lot_comic_drama.cd_takes t ON (t.owner_id,t.request_id)=(r.owner_id,r.id)";
const takes = `${jobs} LEFT JOIN image_call_receipts i ON i.task_id=r.task_id AND i.slot=t.slot AND i.user_id=t.owner_id::text
  WHERE r.confirmed_at>=${cutoff}`;
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const query = async (sql: string) => (await client.query(sql, [hours])).rows;
    const queues = await query(`SELECT type,status,count(*)::int AS jobs,
      round(percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at-created_at)*1000)) AS wait_p95_ms,
      round(percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-run_started_at)*1000)) AS run_p95_ms
      FROM tasks WHERE type IN ${kinds} AND created_at>=${cutoff} GROUP BY type,status ORDER BY type,status`);
    const confirmed = await query(`SELECT count(*)::int AS confirmed_requests FROM lot_comic_drama.cd_generation_requests WHERE confirmed_at>=${cutoff}`);
    const submissions = await query(`SELECT coalesce(t.input->>'modelId','unknown') AS model,t.status,count(*)::int AS takes,
      count(*) FILTER (WHERE t.submit_state IS NOT NULL OR i.state IS NOT NULL)::int AS submission_intents,
      count(*) FILTER (WHERE t.gateway_request_id IS NOT NULL OR i.gateway_request_id IS NOT NULL)::int AS traced,
      sum((r.frozen->'price'->>'amountMicros')::numeric *
        CASE WHEN r.frozen->'price'->>'unit'='second' THEN (t.input->>'durationMs')::numeric/1000 ELSE 1 END)::text AS estimated_micros
      FROM ${takes} GROUP BY model,t.status ORDER BY model,t.status`);
    const recoveries = await query(`SELECT j.type,count(*)::int AS requeues FROM lot_comic_drama.cd_task_recoveries e
      JOIN tasks j ON j.id=e.task_id WHERE e.happened_at>=${cutoff} GROUP BY j.type ORDER BY j.type`);
    const toReconcile = await query(`SELECT r.id AS request_id,t.id AS take_id,r.task_id,t.status,t.submit_state,
      left(regexp_replace(coalesce(t.gateway_request_id,i.gateway_request_id,''),'[^A-Za-z0-9_:.@-]','','g'),150) AS gateway_request_id
      FROM ${takes} AND (t.status IN ('unknown','recoverable','released') OR t.submit_state='unknown')
      ORDER BY r.confirmed_at DESC,t.id LIMIT 100`);
    await client.query("COMMIT");
    const root = process.env.COMIC_DRAMA_REPORT_MEDIA_ROOT || fileURLToPath(new URL("../../../data/comic-drama", import.meta.url));
    const temp = await Promise.all([temporary(root, /^\.(upload|frame|render)-/), temporary(tmpdir(), /^lot-comic-render-/)]);
    console.log(JSON.stringify({ hours, queues, confirmed: confirmed[0], submissions, recoveries, toReconcile,
      temporary: { uploads: temp[0], renders: temp[1] },
      settlement: "Compare gateway receipts with actual bills; local totals are estimates." }, null, 2));
  } finally { client.release(); }
} catch {
  console.error("Comic drama report unavailable. Check database access and migration version.");
  process.exitCode = 1;
} finally { await pool.end(); }
