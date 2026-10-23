import type pg from "pg";
import { DIGITAL_PRESENTER_TASK, marketingQueueLimits } from "../jobs/task-queues.js";
import { UNKNOWN_SUBMISSION } from "../marketing-video/recovery.js";

/** A request row still `running` after this long has lost its process: its outcome is unknown. */
export const STUCK_RUNNING_MINUTES = 15;
const RENDER_TYPES = ["marketing.video", DIGITAL_PRESENTER_TASK];
const TERMINAL = "('succeeded','failed','cancelled')";

export interface Durations { n: number; p50: number | null; p95: number | null; max: number | null }
type Counts = Record<string, number>;

/** Seconds between two timestamps as `{n, p50, p95, max}`; rows without either time are skipped. */
function durations(to: string, from: string, filter = "TRUE") {
  const e = `extract(epoch FROM (${to}) - (${from}))`;
  const pct = (p: number) => `round((percentile_cont(${p}) WITHIN GROUP (ORDER BY ${e}) FILTER (WHERE ${filter}))::numeric, 1)`;
  return `json_build_object('n', count(${e}) FILTER (WHERE ${filter}), 'p50', ${pct(0.5)}, 'p95', ${pct(0.95)},
    'max', round((max(${e}) FILTER (WHERE ${filter}))::numeric, 1))`;
}
const statusCounts = (status = "status") => `count(*)::int AS total,
  count(*) FILTER (WHERE ${status}='succeeded')::int AS succeeded,
  count(*) FILTER (WHERE ${status}='failed')::int AS failed,
  count(*) FILTER (WHERE ${status}='cancelled')::int AS cancelled,
  count(*) FILTER (WHERE ${status} NOT IN ${TERMINAL})::int AS active`;

/** Succeeded share of the outcomes that ended; cancelled and unfinished work is left out. */
function rate(row: Record<string, any>) {
  const ended = row.succeeded + row.failed;
  return ended ? Math.round(row.succeeded / ended * 1000) / 1000 : null;
}
function group<T extends Record<string, any>>(rows: T[], key: (row: T) => string, value: (row: T) => [string, number]) {
  const out = new Map<string, Counts>();
  for (const row of rows) {
    const [name, n] = value(row);
    out.set(key(row), { ...out.get(key(row)), [name]: n });
  }
  return out;
}

/**
 * Quality and performance of marketing videos and digital presenters over the last `hours`,
 * read straight from the task and request tables. Renders, clips and text requests count by
 * their creation time; narration takes by their latest attempt. Backlogs are current.
 * Timings exist only for tasks run after migration 59.
 */
export async function marketingMetrics(pool: pg.Pool, hours: number, env: NodeJS.ProcessEnv = process.env) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const since = new Date(Date.now() - hours * 3_600_000);
    const q = async <T = Record<string, any>>(sql: string, params: unknown[] = [since]) => (await client.query(sql, params)).rows as T[];

    const renderKind = `CASE WHEN input ? 'recomposedFrom' THEN 'recompose' WHEN input ? 'revisedFrom' THEN 'revise' ELSE 'generate' END`;
    const renders = await q(`SELECT type, ${renderKind} AS kind, ${statusCounts()},
        ${durations("started_at", "created_at")} AS queue_wait,
        ${durations("finished_at", "run_started_at", "status='succeeded'")} AS last_run,
        ${durations("finished_at", "created_at", "status='succeeded'")} AS end_to_end
      FROM tasks WHERE type = ANY($2) AND created_at >= $1 GROUP BY 1, 2 ORDER BY 1, 2`, [since, RENDER_TYPES]);
    const renderFailures = group(await q(`SELECT type, ${renderKind} AS kind, COALESCE(error_code, 'none') AS code, count(*)::int AS n
      FROM tasks WHERE type = ANY($2) AND created_at >= $1 AND status='failed' GROUP BY 1, 2, 3`, [since, RENDER_TYPES]), r => `${r.type}\n${r.kind}`, r => [r.code, r.n]);
    // Composition: from the last clip of this run (or the claim, when every clip was reused) to the end.
    const [composition] = await q(`SELECT ${durations("finished_at", "GREATEST(run_started_at, last_clip)")} AS compose
      FROM (SELECT p.finished_at, p.run_started_at, max(s.finished_at) FILTER (WHERE s.finished_at >= p.run_started_at AND NOT COALESCE(s.output ? 'reusedFrom', false)) AS last_clip
        FROM tasks p LEFT JOIN tasks s ON s.type='marketing.segment' AND s.created_at >= $1 AND (s.input->>'parentId')::uuid = p.id
        WHERE p.type='marketing.video' AND p.created_at >= $1 AND p.status='succeeded' GROUP BY p.id) runs`);

    // Clips that were attempted: not reused from an earlier job and not left pending by a stopped render.
    const clipFilter = `s.type='marketing.segment' AND s.created_at >= $1 AND s.status <> 'pending' AND NOT COALESCE(s.output ? 'reusedFrom', false)`;
    const clips = await q(`SELECT COALESCE(p.input->>'modelId', 'unknown') AS model,
        ${statusCounts("s.status")},
        ${durations("s.finished_at", "s.run_started_at", "s.status='succeeded'")} AS last_run
      FROM tasks s JOIN tasks p ON p.id = (s.input->>'parentId')::uuid WHERE ${clipFilter} GROUP BY 1 ORDER BY 1`);
    const clipFailures = group(await q(`SELECT COALESCE(p.input->>'modelId', 'unknown') AS model, COALESCE(s.error_code, 'none') AS code, count(*)::int AS n
      FROM tasks s JOIN tasks p ON p.id = (s.input->>'parentId')::uuid WHERE ${clipFilter} AND s.status='failed' GROUP BY 1, 2`), r => r.model, r => [r.code, r.n]);
    const gateway5xx = group(await q(`SELECT http_status::text AS status, count(*)::int AS n FROM marketing_clip_gateway_failures
      WHERE created_at >= $1 GROUP BY 1`), () => "all", r => [r.status, r.n]).get("all") ?? {};
    const presenterClips = group(await q(`SELECT c.model, c.status, count(*)::int AS n FROM digital_presenter_clips c JOIN tasks t ON t.id=c.task_id
      WHERE t.created_at >= $1 AND NOT (t.input ? 'recomposedFrom') GROUP BY 1, 2`), r => r.model, r => [r.status, r.n]);

    const text = await q(`SELECT kind, model, count(*)::int AS total,
        ${durations("updated_at", "created_at", "status IN ('succeeded','needs_apply','conflict')")} AS responded
      FROM marketing_text_operations WHERE created_at >= $1 GROUP BY 1, 2 ORDER BY 1, 2`);
    const textStatuses = group(await q(`SELECT kind, model, status, count(*)::int AS n FROM marketing_text_operations
      WHERE created_at >= $1 GROUP BY 1, 2, 3`), r => `${r.kind}\n${r.model}`, r => [r.status, r.n]);
    const byStatus = async (table: string, column: string) =>
      group(await q(`SELECT status, count(*)::int AS n FROM ${table} WHERE ${column} >= $1 GROUP BY 1`), () => "all", r => [r.status, r.n]).get("all") ?? {};
    const narrations = await byStatus("marketing_video_narrations", "updated_at");
    const presenterTakes = await byStatus("digital_presenter_takes", "updated_at");
    const keyArts = await byStatus("marketing_video_key_arts", "created_at");
    const [keyArtTime] = await q(`SELECT ${durations("updated_at", "created_at", "status='succeeded'")} AS responded
      FROM marketing_video_key_arts WHERE created_at >= $1`);

    const queue = await q(`SELECT type, count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='running')::int AS running,
        round(extract(epoch FROM now() - min(created_at) FILTER (WHERE status='pending'))::numeric)::int AS oldest_pending_sec
      FROM tasks WHERE type = ANY($1) AND status IN ('pending','running') GROUP BY 1 ORDER BY 1`, [RENDER_TYPES]);
    const backlog = (await q(`SELECT
        (SELECT json_build_object('count', count(*), 'oldestSec', round(extract(epoch FROM now() - min(s.updated_at)))) FROM tasks s
          JOIN tasks p ON p.id = (s.input->>'parentId')::uuid
          WHERE s.type='marketing.segment' AND s.vendor_task_id=$1 AND p.status NOT IN ('pending','running')) AS marketing_clips,
        (SELECT json_build_object('count', count(*), 'oldestSec', round(extract(epoch FROM now() - min(c.updated_at)))) FROM digital_presenter_clips c
          JOIN tasks t ON t.id=c.task_id WHERE c.status='submitting' AND t.status NOT IN ('pending','running')) AS presenter_clips,
        (SELECT json_build_object('count', count(*), 'oldestSec', round(extract(epoch FROM now() - min(updated_at)))) FROM marketing_text_operations
          WHERE status='unknown' OR (status='running' AND updated_at < now() - make_interval(mins => $2))) AS text_requests,
        (SELECT count(*) FROM marketing_text_operations WHERE status='needs_apply' AND updated_at < now() - make_interval(mins => $2)) AS text_unapplied,
        (SELECT count(*) FROM marketing_video_narrations WHERE status='running' AND updated_at < now() - make_interval(mins => $2)) AS narrations,
        (SELECT count(*) FROM digital_presenter_takes WHERE status='running' AND updated_at < now() - make_interval(mins => $2)) AS presenter_takes,
        (SELECT count(*) FROM marketing_video_key_arts WHERE status='running' AND updated_at < now() - make_interval(mins => $2)) AS key_arts`,
      [UNKNOWN_SUBMISSION, STUCK_RUNNING_MINUTES]))[0];
    const [released] = await q(`SELECT
        (SELECT count(*) FROM marketing_video_segments WHERE unknown_released_at >= $1)::int AS marketing_clips,
        (SELECT count(*) FROM marketing_text_operations WHERE released_at >= $1)::int AS text_requests,
        (SELECT count(*) FROM marketing_text_operations WHERE status='cancelled' AND updated_at >= $1)::int AS text_no_response`);
    await client.query("COMMIT");

    let limits: Record<string, unknown>;
    try { limits = { ...marketingQueueLimits(env) }; } catch (error) { limits = { error: (error as Error).message }; }
    const timed = (row: Record<string, any>) => ({ total: row.total, succeeded: row.succeeded, failed: row.failed, cancelled: row.cancelled, active: row.active, successRate: rate(row) });
    return {
      window: { hours, since: since.toISOString(), until: new Date().toISOString() },
      // As this API process reads them; workers may run with other values.
      concurrency: limits,
      queue: queue.map(r => ({ type: r.type, pending: r.pending, running: r.running, oldestPendingSec: r.oldest_pending_sec })),
      renders: renders.map(r => ({ type: r.type, kind: r.kind, ...timed(r), failures: renderFailures.get(`${r.type}\n${r.kind}`) ?? {},
        queueWaitSec: r.queue_wait as Durations, lastRunSec: r.last_run as Durations, endToEndSec: r.end_to_end as Durations })),
      composeSec: composition.compose as Durations,
      clips: clips.map(r => ({ model: r.model, ...timed(r), failures: clipFailures.get(r.model) ?? {}, lastRunSec: r.last_run as Durations })),
      gateway5xx,
      presenterClips: Object.fromEntries(presenterClips),
      textRequests: text.map(r => ({ kind: r.kind, model: r.model, total: r.total, statuses: textStatuses.get(`${r.kind}\n${r.model}`) ?? {}, respondedSec: r.responded as Durations })),
      narrations, presenterTakes,
      keyArts: { statuses: keyArts, respondedSec: keyArtTime.responded as Durations },
      unknownBacklog: {
        stuckAfterMinutes: STUCK_RUNNING_MINUTES,
        marketingClips: backlog.marketing_clips, presenterClips: backlog.presenter_clips, textRequests: backlog.text_requests,
        textUnapplied: Number(backlog.text_unapplied), narrations: Number(backlog.narrations), presenterTakes: Number(backlog.presenter_takes), keyArts: Number(backlog.key_arts),
      },
      releasedInWindow: { marketingClips: released.marketing_clips, textRequests: released.text_requests, textNoResponse: released.text_no_response },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
