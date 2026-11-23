import type { Pool } from "pg";

export type ComicReconcileCategory = "gateway_5xx" | "unknown_submission" | "recoverable" | "released" | "client_4xx" | "other";

export type ComicReconcileInput = {
  status: string;
  submit_state: string | null;
  error: string | null;
  gateway_http_status: number | null;
};

export type ComicReconcileRow = ComicReconcileInput & {
  request_id: string;
  take_id: string;
  task_id: string | null;
  error_category: ComicReconcileCategory;
  gateway_request_id: string;
};

export type ComicSpeechReconcileInput = {
  status: string;
  error: string | null;
  gateway_http_status: number | null;
  stale_submitting?: boolean;
};

export type ComicSpeechReconcileRow = {
  attempt_id: string | null;
  kind: "dialogue" | "audition";
  fingerprint: string;
  edit_id: string | null;
  line_id: string | null;
  model_id: string | null;
  status: string;
  error: string | null;
  gateway_http_status: number | null;
  error_category: ComicReconcileCategory;
  gateway_request_id: string;
};

export function classifyComicSpeechReconcile(row: ComicSpeechReconcileInput): ComicReconcileCategory {
  if (typeof row.gateway_http_status === "number" && row.gateway_http_status >= 500) return "gateway_5xx";
  if (row.status === "released") return "released";
  if (row.status === "unknown" || (row.status === "submitting" && row.stale_submitting)) return "unknown_submission";
  if (typeof row.gateway_http_status === "number" && row.gateway_http_status >= 400 && row.gateway_http_status < 500) return "client_4xx";
  return "other";
}

export function needsComicSpeechReconciliation(row: ComicSpeechReconcileInput): boolean {
  return row.status === "unknown"
    || row.status === "released"
    || (row.status === "submitting" && !!row.stale_submitting)
    || (typeof row.gateway_http_status === "number" && row.gateway_http_status >= 500);
}

export function isGateway5xxFailure(row: ComicReconcileInput): boolean {
  return row.error === "VIDEO_GATEWAY_FAILED" || (typeof row.gateway_http_status === "number" && row.gateway_http_status >= 500);
}

export function classifyComicTakeReconcile(row: ComicReconcileInput): ComicReconcileCategory {
  if (isGateway5xxFailure(row)) return "gateway_5xx";
  if (row.status === "released") return "released";
  if (row.status === "unknown" || row.submit_state === "unknown") return "unknown_submission";
  if (row.status === "recoverable") return "recoverable";
  if (row.submit_state === "rejected" || (typeof row.gateway_http_status === "number" && row.gateway_http_status >= 400 && row.gateway_http_status < 500)) {
    return "client_4xx";
  }
  return "other";
}

export function needsComicTakeReconciliation(row: ComicReconcileInput): boolean {
  return ["unknown", "recoverable", "released"].includes(row.status)
    || row.submit_state === "unknown"
    || isGateway5xxFailure(row);
}

const cutoff = "now()-make_interval(hours=>$1)";
const kinds = "('comic-drama.image','comic-drama.video','comic-drama.render','marketing.video','digital-presenter.video')";
const jobs = "lot_comic_drama.cd_generation_requests r JOIN lot_comic_drama.cd_takes t ON (t.owner_id,t.request_id)=(r.owner_id,r.id)";
const takes = `${jobs} LEFT JOIN image_call_receipts i ON i.task_id=r.task_id AND i.slot=t.slot AND i.user_id=t.owner_id::text
  WHERE r.confirmed_at>=${cutoff}`;

export const COMIC_RECONCILE_SQL = `SELECT r.id AS request_id,t.id AS take_id,r.task_id,t.status,t.submit_state,
  t.error,t.gateway_http_status,
  CASE
    WHEN t.error='VIDEO_GATEWAY_FAILED' OR t.gateway_http_status>=500 THEN 'gateway_5xx'
    WHEN t.status='released' THEN 'released'
    WHEN t.status='unknown' OR t.submit_state='unknown' THEN 'unknown_submission'
    WHEN t.status='recoverable' THEN 'recoverable'
    WHEN t.submit_state='rejected' OR (t.gateway_http_status>=400 AND t.gateway_http_status<500) THEN 'client_4xx'
    ELSE 'other'
  END AS error_category,
  left(regexp_replace(coalesce(t.gateway_request_id,i.gateway_request_id,''),'[^A-Za-z0-9_:.@-]','','g'),150) AS gateway_request_id
  FROM ${takes}
    AND (t.status IN ('unknown','recoverable','released')
      OR t.submit_state='unknown'
      OR t.error='VIDEO_GATEWAY_FAILED'
      OR t.gateway_http_status>=500)
  ORDER BY r.confirmed_at DESC,t.id LIMIT 100`;

export const COMIC_SPEECH_RECONCILE_SQL = `SELECT a.id AS attempt_id, a.kind, left(a.fingerprint, 24) AS fingerprint,
  a.edit_id, a.line_id, a.model_id,
  CASE WHEN a.status='submitting' AND a.updated_at<now()-interval '5 minutes' THEN 'unknown' ELSE a.status END AS status,
  a.error, a.gateway_http_status,
  CASE
    WHEN a.gateway_http_status>=500 THEN 'gateway_5xx'
    WHEN a.status='released' THEN 'released'
    WHEN a.status='unknown' OR (a.status='submitting' AND a.updated_at<now()-interval '5 minutes') THEN 'unknown_submission'
    WHEN a.gateway_http_status>=400 AND a.gateway_http_status<500 THEN 'client_4xx'
    ELSE 'other'
  END AS error_category,
  left(regexp_replace(coalesce(a.gateway_request_id,''),'[^A-Za-z0-9_:.@-]','','g'),150) AS gateway_request_id
  FROM lot_comic_drama.cd_speech_attempts a
  WHERE a.updated_at>=${cutoff}
    AND (a.status IN ('unknown','released')
      OR (a.status='submitting' AND a.updated_at<now()-interval '5 minutes')
      OR a.gateway_http_status>=500)
  UNION ALL
  SELECT NULL::uuid AS attempt_id, c.kind, left(c.fingerprint, 24) AS fingerprint,
  NULL::uuid AS edit_id, NULL::uuid AS line_id, NULL::text AS model_id,
  CASE WHEN c.status='submitting' AND c.updated_at<now()-interval '5 minutes' THEN 'unknown' ELSE c.status END AS status,
  NULL::text AS error, NULL::int AS gateway_http_status,
  CASE WHEN c.status='released' THEN 'released' ELSE 'unknown_submission' END AS error_category,
  left(regexp_replace(coalesce(c.gateway_request_id,''),'[^A-Za-z0-9_:.@-]','','g'),150) AS gateway_request_id
  FROM lot_comic_drama.cd_speech_cache c
  WHERE c.updated_at>=${cutoff}
    AND c.active_attempt_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM lot_comic_drama.cd_speech_attempts a
      WHERE a.owner_id=c.owner_id AND a.fingerprint=c.fingerprint
    )
    AND (c.status IN ('unknown','released') OR (c.status='submitting' AND c.updated_at<now()-interval '5 minutes'))
  ORDER BY attempt_id DESC NULLS LAST LIMIT 100`;

export async function queryComicDramaReport(pool: Pool, hours: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const query = async <T extends Record<string, unknown>>(sql: string) => (await client.query<T>(sql, [hours])).rows;
    const queues = await query(`SELECT type,status,count(*)::int AS jobs,
      round(percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at-created_at)*1000)) AS wait_p95_ms,
      round(percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-run_started_at)*1000)) AS run_p95_ms
      FROM tasks WHERE type IN ${kinds} AND created_at>=${cutoff} GROUP BY type,status ORDER BY type,status`);
    const confirmed = await query<{ confirmed_requests: number }>(
      `SELECT count(*)::int AS confirmed_requests FROM lot_comic_drama.cd_generation_requests WHERE confirmed_at>=${cutoff}`);
    const submissions = await query(`SELECT coalesce(t.input->>'modelId','unknown') AS model,t.status,count(*)::int AS takes,
      count(*) FILTER (WHERE t.submit_state IS NOT NULL OR i.state IS NOT NULL)::int AS submission_intents,
      count(*) FILTER (WHERE t.gateway_request_id IS NOT NULL OR i.gateway_request_id IS NOT NULL)::int AS traced,
      count(*) FILTER (WHERE t.error='VIDEO_GATEWAY_FAILED' OR t.gateway_http_status>=500)::int AS gateway_5xx,
      count(*) FILTER (WHERE t.submit_state='rejected' AND coalesce(t.error,'')<>'VIDEO_GATEWAY_FAILED'
        AND coalesce(t.gateway_http_status,0)<500)::int AS client_4xx,
      sum((r.frozen->'price'->>'amountMicros')::numeric *
        CASE WHEN r.frozen->'price'->>'unit'='second' THEN (t.input->>'durationMs')::numeric/1000 ELSE 1 END)::text AS estimated_micros
      FROM ${takes} GROUP BY model,t.status ORDER BY model,t.status`);
    const speechSubmissions = await query(`SELECT kind, model_id AS model, status, count(*)::int AS attempts,
      count(*) FILTER (WHERE gateway_request_id IS NOT NULL)::int AS traced,
      count(*) FILTER (WHERE gateway_http_status>=500)::int AS gateway_5xx
      FROM lot_comic_drama.cd_speech_attempts WHERE updated_at>=${cutoff}
      GROUP BY kind, model_id, status ORDER BY kind, model_id, status`);
    const recoveries = await query(`SELECT j.type,count(*)::int AS requeues FROM lot_comic_drama.cd_task_recoveries e
      JOIN tasks j ON j.id=e.task_id WHERE e.happened_at>=${cutoff} GROUP BY j.type ORDER BY j.type`);
    const toReconcile = await query<ComicReconcileRow>(COMIC_RECONCILE_SQL);
    const speechToReconcile = await query<ComicSpeechReconcileRow>(COMIC_SPEECH_RECONCILE_SQL);
    await client.query("COMMIT");
    return { queues, confirmed: confirmed[0], submissions, speechSubmissions, recoveries, toReconcile, speechToReconcile };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
