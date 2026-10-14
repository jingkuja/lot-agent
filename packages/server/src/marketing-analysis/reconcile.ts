import type { ModelStepReceipt } from "@lot-agent/core/marketing-analysis";
import { PgAnalysisStore, ownerLock } from "./repository.js";
import { validReceiptUsage } from "./ledger.js";
import { AnalysisError } from "./errors.js";

/** Operator-only reconciliation after checking gateway receipts. No HTTP or
 * model tool exposes this capability, and reconciliation never queues work. */
export async function reconcileAnalysisStep(store: PgAnalysisStore, owner: string, id: string, stepId: string, attempt: number, receipt: ModelStepReceipt, note: string) {
  if (!validReceiptUsage(receipt) || !["completed", "failed"].includes(receipt.outcome) || typeof receipt.responseId !== "string" || !receipt.responseId || receipt.responseId.length > 500
    || typeof receipt.text !== "string" || receipt.text.length > 60000 || !note.trim() || note.length > 1000 || !Number.isSafeInteger(attempt) || attempt < 1) throw new AnalysisError("INVALID_RECONCILIATION");
  await store.transaction(async client => {
    await ownerLock(client, owner); const row = await store.row(owner, id, client, true);
    if (["queued", "running"].includes(row.status) || (row.lease_until && new Date(row.lease_until).getTime() > Date.now())) throw new AnalysisError("ANALYSIS_BUSY", 409);
    const step = (await client.query("SELECT * FROM marketing_analysis_steps WHERE analysis_id=$1 AND user_id=$2 AND step_id=$3 AND attempt=$4 FOR UPDATE", [id, owner, stepId, attempt])).rows[0];
    if (!step || (step.actual_cost !== null || (step.receipt?.outcome !== "request_unknown" && step.receipt?.usage)) || (step.receipt?.responseId && step.receipt.responseId !== receipt.responseId)) throw new AnalysisError("MODEL_RECEIPT_CONFLICT", 409);
    await client.query(`UPDATE marketing_analysis_steps SET receipt=$5,reconciliation=$6,updated_at=now()
      WHERE analysis_id=$1 AND user_id=$2 AND step_id=$3 AND attempt=$4`, [id, owner, stepId, attempt, JSON.stringify(receipt), JSON.stringify({ previousReceipt: step.receipt, note, at: new Date().toISOString() })]);
    await client.query(`UPDATE marketing_reference_analyses SET reserved_cost=0,
      status='partial',error_code='RECONCILED_RESUME_REQUIRED',version=version+1,updated_at=now() WHERE id=$1`, [id]);
  });
}
