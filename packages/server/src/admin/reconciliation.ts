import type pg from "pg";
import { STUCK_RUNNING_MINUTES } from "./metrics.js";
import { UNKNOWN_SUBMISSION } from "../marketing-video/recovery.js";

/** Rows per category; a full category is named in `truncated` so nothing is silently cut. */
export const RECONCILIATION_LIMIT = 200;

/**
 * `none`: the gateway answered without a result, so it should not have charged; a charge in
 * its logs is refunded. `unknown`: the request may have been charged with no result kept;
 * the gateway logs decide.
 */
export type ExpectedCharge = "none" | "unknown";
export interface ReconciliationItem {
  /** Open items are still unknown and stay listed until they settle; closed ones fall in the window. */
  category: string; expectedCharge: ExpectedCharge; open: boolean;
  ownerId: string; gatewayUserId: string | null; gatewayTokenId: string | null;
  projectId: string | null; taskId: string | null; slot: number | null;
  /** The row's own ID where task and slot do not identify it (text requests, gateway failures). */
  recordId: string | null;
  requestKind: string | null; model: string | null; gatewayRequestId: string | null; httpStatus: number | null;
  status: string; since: string; ageHours: number;
}

// Each query returns the shared columns; `at` is when the request went out or was last tried.
// Parameters by name: :since (window start), :stuck (minutes), :unknown (clip marker).
const CATEGORIES: { category: string; expectedCharge: ExpectedCharge; open: boolean; sql: string }[] = [
  { category: "clip_gateway_5xx", expectedCharge: "none", open: false, sql: `SELECT f.owner_id, f.project_id::text, f.task_id::text, NULL::int AS slot, f.id::text AS record_id,
      NULL AS request_kind, p.input->>'modelId' AS model, f.gateway_request_id, f.http_status, 'gateway_failed' AS status, f.created_at AS at
    FROM marketing_clip_gateway_failures f LEFT JOIN tasks s ON s.id=f.task_id LEFT JOIN tasks p ON p.id=(s.input->>'parentId')::uuid
    WHERE f.created_at >= :since` },
  { category: "text_no_response", expectedCharge: "none", open: false, sql: `SELECT user_id AS owner_id, project_id::text, NULL AS task_id, NULL::int AS slot, id::text AS record_id,
      kind AS request_kind, model, receipt->>'gatewayRequestId' AS gateway_request_id, NULL::int AS http_status, status, created_at AS at
    FROM marketing_text_operations WHERE status='cancelled' AND updated_at >= :since` },
  // Open items stay listed until their status changes, whatever the window.
  { category: "text_unknown", expectedCharge: "unknown", open: true, sql: `SELECT user_id AS owner_id, project_id::text, NULL AS task_id, NULL::int AS slot, id::text AS record_id,
      kind AS request_kind, model, receipt->>'gatewayRequestId' AS gateway_request_id, NULL::int AS http_status, status, created_at AS at
    FROM marketing_text_operations WHERE status='unknown' OR (status='running' AND updated_at < now() - make_interval(mins => :stuck))` },
  { category: "text_released", expectedCharge: "unknown", open: false, sql: `SELECT user_id AS owner_id, project_id::text, NULL AS task_id, NULL::int AS slot, id::text AS record_id,
      kind AS request_kind, model, receipt->>'gatewayRequestId' AS gateway_request_id, NULL::int AS http_status, status, created_at AS at
    FROM marketing_text_operations WHERE released_at >= :since` },
  { category: "clip_unknown", expectedCharge: "unknown", open: true, sql: `SELECT s.user_id AS owner_id, ms.project_id::text, s.id::text AS task_id, ms.slot, NULL AS record_id,
      NULL AS request_kind, p.input->>'modelId' AS model, NULL AS gateway_request_id, NULL::int AS http_status, s.status, s.updated_at AS at
    FROM tasks s JOIN tasks p ON p.id=(s.input->>'parentId')::uuid LEFT JOIN marketing_video_segments ms ON ms.task_id=s.id
    WHERE s.type='marketing.segment' AND s.vendor_task_id=:unknown AND p.status NOT IN ('pending','running')` },
  { category: "clip_released", expectedCharge: "unknown", open: false, sql: `SELECT p.user_id AS owner_id, ms.project_id::text, ms.task_id::text, ms.slot, NULL AS record_id,
      NULL AS request_kind, p.input->>'modelId' AS model, NULL AS gateway_request_id, NULL::int AS http_status,
      'released ' || ms.unknown_released_count AS status, ms.unknown_released_at AS at
    FROM marketing_video_segments ms JOIN tasks s ON s.id=ms.task_id JOIN tasks p ON p.id=(s.input->>'parentId')::uuid
    WHERE ms.unknown_released_at >= :since` },
  { category: "presenter_clip_gateway_5xx", expectedCharge: "none", open: false, sql: `SELECT owner_id, project_id::text, task_id::text, slot, id::text AS record_id,
      NULL AS request_kind, model, gateway_request_id, http_status, 'gateway_failed' AS status, created_at AS at
    FROM digital_presenter_clip_gateway_failures WHERE created_at >= :since` },
  { category: "presenter_clip_unknown", expectedCharge: "unknown", open: true, sql: `SELECT t.user_id AS owner_id, t.input->>'projectId' AS project_id, c.task_id::text, c.slot, NULL AS record_id,
      NULL AS request_kind, c.model, NULL AS gateway_request_id, NULL::int AS http_status, c.status, c.updated_at AS at
    FROM digital_presenter_clips c JOIN tasks t ON t.id=c.task_id WHERE c.status='submitting' AND t.status NOT IN ('pending','running')` },
  { category: "presenter_clip_released", expectedCharge: "unknown", open: false, sql: `SELECT t.user_id AS owner_id, t.input->>'projectId' AS project_id, c.task_id::text, c.slot, NULL AS record_id,
      NULL AS request_kind, c.model, NULL AS gateway_request_id, NULL::int AS http_status, 'released ' || c.released_count AS status, c.updated_at AS at
    FROM digital_presenter_clips c JOIN tasks t ON t.id=c.task_id WHERE c.released_count > 0 AND c.updated_at >= :since` },
  { category: "narration_stuck", expectedCharge: "unknown", open: true, sql: `SELECT owner_id, project_id::text, NULL AS task_id, slot, NULL AS record_id,
      'speech' AS request_kind, NULL AS model, NULL AS gateway_request_id, NULL::int AS http_status, status, updated_at AS at
    FROM marketing_video_narrations WHERE status='running' AND updated_at < now() - make_interval(mins => :stuck)` },
  { category: "presenter_take_stuck", expectedCharge: "unknown", open: true, sql: `SELECT p.user_id AS owner_id, k.project_id::text, NULL AS task_id, k.slot, NULL AS record_id,
      'speech' AS request_kind, NULL AS model, NULL AS gateway_request_id, NULL::int AS http_status, k.status, k.updated_at AS at
    FROM digital_presenter_takes k JOIN digital_presenter_projects p ON p.id=k.project_id
    WHERE k.status='running' AND k.updated_at < now() - make_interval(mins => :stuck)` },
  { category: "key_art_stuck", expectedCharge: "unknown", open: true, sql: `SELECT owner_id, project_id::text, NULL AS task_id, NULL::int AS slot, NULL AS record_id,
      'image' AS request_kind, NULL AS model, NULL AS gateway_request_id, NULL::int AS http_status, status, created_at AS at
    FROM marketing_video_key_arts WHERE status='running' AND updated_at < now() - make_interval(mins => :stuck)` },
];

/**
 * Marketing video and digital presenter requests whose charge must be checked in the gateway
 * logs, oldest first. Closed items (gateway 5xx, no response, released by the user) fall in
 * the last `hours`; open items (still unknown) are listed until they settle. Gateway user and
 * token IDs come from the account; keys are never read.
 */
export async function marketingReconciliation(pool: pg.Pool, hours: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const since = new Date(Date.now() - hours * 3_600_000);
    const values: Record<string, unknown> = { since, stuck: STUCK_RUNNING_MINUTES, unknown: UNKNOWN_SUBMISSION };
    const items: ReconciliationItem[] = [];
    const truncated: string[] = [];
    for (const c of CATEGORIES) {
      const params: unknown[] = [];
      const sql = c.sql.replace(/(?<!:):(since|stuck|unknown)\b/g, (_, name: string) => `$${params.push(values[name])}`);
      const { rows } = await client.query(`SELECT x.*, u.external_user_id::text AS gateway_user_id, u.managed_token_id::text AS gateway_token_id,
          extract(epoch FROM now() - x.at) / 3600 AS age_hours
        FROM (${sql}) x LEFT JOIN users u ON u.id::text = x.owner_id ORDER BY x.at LIMIT ${RECONCILIATION_LIMIT + 1}`, params);
      if (rows.length > RECONCILIATION_LIMIT) { truncated.push(c.category); rows.length = RECONCILIATION_LIMIT; }
      for (const r of rows) {
        items.push({ category: c.category, expectedCharge: c.expectedCharge, open: c.open,
          ownerId: r.owner_id, gatewayUserId: r.gateway_user_id, gatewayTokenId: r.gateway_token_id,
          projectId: r.project_id, taskId: r.task_id, slot: r.slot, recordId: r.record_id, requestKind: r.request_kind, model: r.model,
          gatewayRequestId: r.gateway_request_id, httpStatus: r.http_status, status: r.status, since: new Date(r.at).toISOString(),
          ageHours: Math.round(Number(r.age_hours) * 10) / 10 });
      }
    }
    await client.query("COMMIT");
    items.sort((a, b) => a.since.localeCompare(b.since));
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
    return { window: { hours, since: since.toISOString(), until: new Date().toISOString() }, counts, truncated, items };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
