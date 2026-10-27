import type { Migration } from "../migration-runner.js";

/** Reference analysis calls that got nothing back (no text, usage or response ID) were kept as
 * unknown and blocked the analysis for good. They now end `cancelled`: not charged and resumable.
 * Settle the existing ones and reopen analyses they alone were blocking. Calls in a queued or running
 * analysis are left to the worker. */
export const marketingAnalysisNoResponse: Migration = {
  version: 64, name: "marketing-analysis-no-response",
  async up(client) {
    await client.query(`UPDATE marketing_analysis_steps s
      SET receipt=s.receipt || '{"outcome":"cancelled","errorCode":"MODEL_NO_RESPONSE"}'::jsonb,updated_at=now()
      FROM marketing_reference_analyses a
      WHERE a.id=s.analysis_id AND a.status NOT IN ('queued','running')
        AND s.receipt->>'outcome'='request_unknown' AND s.receipt->'usage' IS NULL AND s.receipt->>'responseId' IS NULL
        AND COALESCE(s.receipt->>'text','')=''`);
    await client.query(`WITH reopened AS (
        UPDATE marketing_reference_analyses a SET
          status=CASE WHEN a.status='cancelled' THEN 'cancelled'
            WHEN jsonb_array_length(COALESCE(a.snapshot->'texts','[]'::jsonb))>0 THEN 'partial' ELSE 'failed' END,
          error_code=CASE WHEN a.status='cancelled' THEN NULL ELSE 'MODEL_NO_RESPONSE' END,
          version=a.version+1,updated_at=now()
        WHERE a.error_code='REQUEST_UNKNOWN' AND a.status IN ('needs_review','cancelled') AND a.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM marketing_analysis_steps s WHERE s.analysis_id=a.id AND s.receipt->>'outcome'='cancelled')
          AND NOT EXISTS (SELECT 1 FROM marketing_analysis_steps s WHERE s.analysis_id=a.id AND (s.receipt IS NULL
            OR s.receipt->>'outcome'='request_unknown' OR (s.receipt->'usage' IS NULL AND s.receipt->>'outcome' NOT IN ('rejected','cancelled'))))
        RETURNING a.id,a.error_code)
      UPDATE tasks t SET error=r.error_code,updated_at=now() FROM reopened r WHERE t.id=r.id AND t.error='REQUEST_UNKNOWN'`);
  },
};
