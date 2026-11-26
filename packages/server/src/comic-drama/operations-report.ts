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

export type ComicBillingVarianceRow = {
  model: string;
  currency: string;
  settled_takes: number;
  unbilled_ready_takes: number;
  pending_reconcile_takes: number;
  quoted_micros: string;
  settled_micros: string;
};

export type ComicRenderStatsRow = {
  total: number;
  ready: number;
  failed: number;
  cancelled: number;
  run_p50_ms: number | string | null;
  run_p95_ms: number | string | null;
  run_max_ms: number | string | null;
  fps_24_count: number;
  fps_30_count: number;
};

export type ComicPilotSummary = {
  queueWaitP95MsByQueue: Record<string, number | null>;
  unknownSubmissionCount: number;
  gateway5xxCount: number;
  renderTotal: number;
  renderFailedCount: number;
  renderRunP95Ms: number | null;
  renderFps24Count: number;
  renderFps30Count: number;
  tempTotalBytes: number;
  tempFreeBytes: number | null;
  mediaFreeBytes: number | null;
  billingVariance: Array<{
    model: string;
    currency: string;
    settledTakes: number;
    unbilledReadyTakes: number;
    pendingReconcileTakes: number;
    quotedMicros: number;
    settledMicros: number;
    variancePct: number | null;
  }>;
};

const cutoff = "now()-make_interval(hours=>$1)";
const kinds = "('comic-drama.image','comic-drama.video','comic-drama.render','marketing.video','digital-presenter.video')";
const jobs = "lot_comic_drama.cd_generation_requests r JOIN lot_comic_drama.cd_takes t ON (t.owner_id,t.request_id)=(r.owner_id,r.id)";
const takes = `${jobs} LEFT JOIN image_call_receipts i ON i.task_id=r.task_id AND i.slot=t.slot AND i.user_id=t.owner_id::text
  WHERE r.confirmed_at>=${cutoff}`;

export const COMIC_RENDER_STATS_SQL = `SELECT count(*)::int AS total,
  count(*) FILTER (WHERE r.media_id IS NOT NULL OR r.deleted_at IS NOT NULL)::int AS ready,
  count(*) FILTER (WHERE r.media_id IS NULL AND r.deleted_at IS NULL AND t.status='failed')::int AS failed,
  count(*) FILTER (WHERE r.media_id IS NULL AND r.deleted_at IS NULL AND t.status='cancelled')::int AS cancelled,
  round(percentile_cont(.50) WITHIN GROUP (ORDER BY extract(epoch FROM t.finished_at-t.run_started_at)*1000)) AS run_p50_ms,
  round(percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM t.finished_at-t.run_started_at)*1000)) AS run_p95_ms,
  round(max(extract(epoch FROM t.finished_at-t.run_started_at)*1000)) AS run_max_ms,
  count(*) FILTER (WHERE r.frozen->>'outputFps'='24')::int AS fps_24_count,
  count(*) FILTER (WHERE r.frozen->>'outputFps'='30')::int AS fps_30_count
  FROM lot_comic_drama.cd_renders r
  LEFT JOIN tasks t ON t.id=r.id AND t.user_id=r.owner_id::text AND t.type='comic-drama.render'
  WHERE r.created_at>=${cutoff} AND r.ephemeral=FALSE`;

export const COMIC_BILLING_VARIANCE_SQL = `SELECT coalesce(t.input->>'modelId','unknown') AS model,
  coalesce(t.settled_currency, r.frozen->'price'->>'currency', 'CNY') AS currency,
  count(*) FILTER (WHERE t.settled_amount_micros IS NOT NULL)::int AS settled_takes,
  count(*) FILTER (WHERE t.status='ready' AND t.settled_amount_micros IS NULL)::int AS unbilled_ready_takes,
  count(*) FILTER (WHERE t.settled_amount_micros IS NULL AND (t.status IN ('unknown','released') OR t.gateway_http_status>=500))::int
    AS pending_reconcile_takes,
  coalesce(sum(CASE WHEN t.settled_amount_micros IS NOT NULL THEN coalesce(
    (r.frozen->'price'->'clipAmounts'->>t.target_id::text)::numeric,
    (r.frozen->'price'->>'amountMicros')::numeric * CASE WHEN r.frozen->'price'->>'unit'='second'
      THEN (t.input->>'durationMs')::numeric/1000 ELSE 1 END
  ) ELSE 0 END), 0)::text AS quoted_micros,
  coalesce(sum(t.settled_amount_micros), 0)::text AS settled_micros
  FROM ${takes}
  GROUP BY model, currency
  ORDER BY model, currency`;

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
    AND t.credit_check IS NULL AND (t.status IN ('unknown','recoverable','released')
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

export function summarizeComicPilotReport(
  report: Awaited<ReturnType<typeof queryComicDramaReport>>,
  temporary?: { uploads?: { bytes: number; freeBytes?: number | null }; renders?: { bytes: number; freeBytes?: number | null } },
): ComicPilotSummary {
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const queueWaitP95MsByQueue: Record<string, number | null> = {};
  for (const row of report.queues) {
    const key = typeof row.queue_name === "string" ? row.queue_name : String(row.type ?? "unknown");
    const wait = num(row.wait_p95_ms);
    if (wait === null) {
      if (!(key in queueWaitP95MsByQueue)) queueWaitP95MsByQueue[key] = null;
      continue;
    }
    const prev = queueWaitP95MsByQueue[key];
    queueWaitP95MsByQueue[key] = prev === null || prev === undefined ? wait : Math.max(prev, wait);
  }
  const unknownSubmissionCount = report.toReconcile.filter(row => row.error_category === "unknown_submission").length
    + report.speechToReconcile.filter(row => row.error_category === "unknown_submission").length;
  const gateway5xxCount = report.submissions.reduce((sum, row) => sum + (num(row.gateway_5xx) ?? 0), 0)
    + report.speechSubmissions.reduce((sum, row) => sum + (num(row.gateway_5xx) ?? 0), 0);
  const renders = report.renders;
  const billingVariance = report.billingVariance.map(row => {
    const quotedMicros = num(row.quoted_micros) ?? 0;
    const settledMicros = num(row.settled_micros) ?? 0;
    const variancePct = quotedMicros > 0
      ? Math.round(((settledMicros - quotedMicros) / quotedMicros) * 10_000) / 100
      : null;
    return {
      model: row.model,
      currency: row.currency,
      settledTakes: Number(row.settled_takes ?? 0),
      unbilledReadyTakes: Number(row.unbilled_ready_takes ?? 0),
      pendingReconcileTakes: Number(row.pending_reconcile_takes ?? 0),
      quotedMicros,
      settledMicros,
      variancePct,
    };
  });
  return {
    queueWaitP95MsByQueue,
    unknownSubmissionCount,
    gateway5xxCount,
    renderTotal: Number(renders?.total ?? 0),
    renderFailedCount: Number(renders?.failed ?? 0),
    renderRunP95Ms: num(renders?.run_p95_ms),
    renderFps24Count: Number(renders?.fps_24_count ?? 0),
    renderFps30Count: Number(renders?.fps_30_count ?? 0),
    tempTotalBytes: (temporary?.uploads?.bytes ?? 0) + (temporary?.renders?.bytes ?? 0),
    tempFreeBytes: temporary?.renders?.freeBytes ?? null,
    mediaFreeBytes: temporary?.uploads?.freeBytes ?? null,
    billingVariance,
  };
}

export async function queryComicDramaReport(pool: Pool, hours: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const query = async <T extends Record<string, unknown>>(sql: string) => (await client.query<T>(sql, [hours])).rows;
    const queues = await query(`SELECT queue_name,type,status,count(*)::int AS jobs,
      round(percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at-created_at)*1000)) AS wait_p95_ms,
      round(percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-run_started_at)*1000)) AS run_p95_ms
      FROM tasks WHERE type IN ${kinds} AND created_at>=${cutoff} GROUP BY queue_name,type,status ORDER BY queue_name,type,status`);
    const confirmed = await query<{ confirmed_requests: number }>(
      `SELECT count(*)::int AS confirmed_requests FROM lot_comic_drama.cd_generation_requests WHERE confirmed_at>=${cutoff}`);
    const submissions = await query(`SELECT coalesce(t.input->>'modelId','unknown') AS model,t.status,count(*)::int AS takes,
      count(*) FILTER (WHERE t.submit_state IS NOT NULL OR i.state IS NOT NULL)::int AS submission_intents,
      count(*) FILTER (WHERE t.gateway_request_id IS NOT NULL OR i.gateway_request_id IS NOT NULL)::int AS traced,
      count(*) FILTER (WHERE t.error='VIDEO_GATEWAY_FAILED' OR t.gateway_http_status>=500)::int AS gateway_5xx,
      count(*) FILTER (WHERE t.submit_state='rejected' AND coalesce(t.error,'')<>'VIDEO_GATEWAY_FAILED'
        AND coalesce(t.gateway_http_status,0)<500)::int AS client_4xx,
      sum(coalesce(
        (r.frozen->'price'->'clipAmounts'->>t.target_id::text)::numeric,
        (r.frozen->'price'->>'amountMicros')::numeric *
          CASE WHEN r.frozen->'price'->>'unit'='second' THEN (t.input->>'durationMs')::numeric/1000 ELSE 1 END
      ))::text AS estimated_micros
      FROM ${takes} GROUP BY model,t.status ORDER BY model,t.status`);
    const speechSubmissions = await query(`SELECT kind, model_id AS model, status, count(*)::int AS attempts,
      count(*) FILTER (WHERE gateway_request_id IS NOT NULL)::int AS traced,
      count(*) FILTER (WHERE gateway_http_status>=500)::int AS gateway_5xx
      FROM lot_comic_drama.cd_speech_attempts WHERE updated_at>=${cutoff}
      GROUP BY kind, model_id, status ORDER BY kind, model_id, status`);
    const renders = await query<ComicRenderStatsRow>(COMIC_RENDER_STATS_SQL);
    const billingVariance = await query<ComicBillingVarianceRow>(COMIC_BILLING_VARIANCE_SQL);
    const recoveries = await query(`SELECT j.type,count(*)::int AS requeues FROM lot_comic_drama.cd_task_recoveries e
      JOIN tasks j ON j.id=e.task_id WHERE e.happened_at>=${cutoff} GROUP BY j.type ORDER BY j.type`);
    const toReconcile = await query<ComicReconcileRow>(COMIC_RECONCILE_SQL);
    const speechToReconcile = await query<ComicSpeechReconcileRow>(COMIC_SPEECH_RECONCILE_SQL);
    await client.query("COMMIT");
    return {
      queues, confirmed: confirmed[0], submissions, speechSubmissions,
      renders: renders[0], billingVariance, recoveries, toReconcile, speechToReconcile,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
