import { calcCost, type ModelConfig } from "@lot-agent/core";
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
    if (!step || step.actual_cost !== null || (step.receipt?.responseId && step.receipt.responseId !== receipt.responseId)) throw new AnalysisError("MODEL_RECEIPT_CONFLICT", 409);
    const config = (row.pricing as ModelConfig[]).find(p => p.id === step.model)!;
    const usage = receipt.usage!; const cost = calcCost(config, { inputCount: usage.promptTokens, outputCount: usage.completionTokens });
    await client.query(`UPDATE marketing_analysis_steps SET receipt=$5,actual_cost=$6,reconciliation=$7,updated_at=now()
      WHERE analysis_id=$1 AND user_id=$2 AND step_id=$3 AND attempt=$4`, [id, owner, stepId, attempt, JSON.stringify(receipt), cost, JSON.stringify({ previousReceipt: step.receipt, note, at: new Date().toISOString() })]);
    await client.query(`INSERT INTO usage_logs(user_id,task_id,model_id,model_type,input_count,output_count,total_cost,idempotency_key)
      VALUES($1,$2,$3,'llm',$4,$5,$6,$7) ON CONFLICT(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`, [owner, id, step.model, usage.promptTokens, usage.completionTokens, cost, `media-analysis:${id}:${stepId}:${attempt}`]);
    await client.query(`UPDATE marketing_reference_analyses SET spent=(SELECT COALESCE(sum(actual_cost),0) FROM marketing_analysis_steps WHERE analysis_id=$1),
      reserved_cost=(SELECT COALESCE(sum(reserved_cost),0) FROM marketing_analysis_steps WHERE analysis_id=$1 AND actual_cost IS NULL),
      status='partial',error_code='RECONCILED_RESUME_REQUIRED',version=version+1,updated_at=now() WHERE id=$1`, [id]);
  });
}
