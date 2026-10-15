import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PgAnalysisStore } from "./repository.js";
import type { AnalysisStorage } from "./storage.js";
import { collectAnalysisUploads } from "./uploads.js";

export const SOURCE_RETENTION_DAYS = 7;
/** Row locks coordinate retention with resume/claim/delete. Source expiry
 * retains frame evidence, revisions and model receipts. Unfinished speech still
 * depends on the source, so expiry must be explicit rather than "no audio".
 * Seven days is a hard privacy bound, including interrupted/unknown requests. */
export async function collectAnalysisFiles(store: PgAnalysisStore, storage: AnalysisStorage) {
  await store.transaction(async client => {
    await collectAnalysisUploads(client, storage);
    const rows = (await client.query(`SELECT * FROM marketing_reference_analyses WHERE
      (deleted_at IS NOT NULL AND files_cleaned_at IS NULL) OR
      (deleted_at IS NULL AND status NOT IN ('queued','running') AND (lease_until IS NULL OR lease_until<now())
        AND created_at<now()-interval '7 days' AND scratch_cleaned_at IS NULL)
      ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
    for (const row of rows) {
      if (row.deleted_at) {
        await storage.remove(row.user_id, row.id);
        await client.query("UPDATE marketing_reference_analyses SET files_cleaned_at=now() WHERE id=$1", [row.id]);
      } else {
        const key = row.snapshot.source.mediaKey;
        if (key && !/^source\.(mp4|webm|mkv)$/.test(key)) continue;
        const directory = await storage.directory(row.user_id, row.id);
        const speechNeeded = row.selection && !row.snapshot.speech && !(await client.query(`SELECT 1 FROM marketing_analysis_steps
          WHERE analysis_id=$1 AND user_id=$2 AND (step_id LIKE 'summary:%' OR step_id LIKE 'copy:%'
            OR (step_id='asr:source' AND receipt->>'outcome'='completed' AND receipt->'usage' IS NOT NULL)) LIMIT 1`, [row.id, row.user_id])).rowCount;
        // Keep the immutable selection and every displayed/referenced frame.
        // Only scratch bytes and candidates absent from both manifests expire.
        const retained = new Set([
          ...(row.snapshot.frames ?? []).map((f: { objectKey: string }) => f.objectKey),
          ...["frames", "ocr", "visual"].flatMap(name => (row.selection?.[name] ?? []).map((f: { objectKey: string }) => f.objectKey)),
        ]);
        for (const name of await readdir(directory)) {
          if (name === key || name === "gray.raw" || name === "speech.wav" || (/^frame-\d{4}\.jpg$/.test(name) && !retained.has(name))) await rm(join(directory, name), { force: true });
        }
        await client.query(`UPDATE marketing_reference_analyses SET scratch_cleaned_at=now(),snapshot=snapshot #- '{source,mediaKey}',
          error_code=CASE WHEN $2::boolean AND status<>'needs_review' THEN 'SOURCE_EXPIRED' ELSE error_code END WHERE id=$1`, [row.id, !!speechNeeded]);
      }
    }
  });
}
