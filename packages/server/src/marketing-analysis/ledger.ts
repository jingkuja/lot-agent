import { calcCost, type ModelConfig } from "@lot-agent/core";
import type { AnalysisCallLedger, AnalysisLease, ModelStepReceipt } from "@lot-agent/core/marketing-analysis";
import { ANALYSIS_LIMITS } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import { PgAnalysisStore, ownerLock, checkReservation } from "./repository.js";

export function validReceiptUsage(receipt: ModelStepReceipt) {
  return receipt.usage && [receipt.usage.promptTokens, receipt.usage.completionTokens].every(n => Number.isSafeInteger(n) && n >= 0);
}
/** Intent, budget consumption, response and idempotent usage log are committed
 * in PG. Queue retries can only read the existing intent, never resubmit it. */
export class PgAnalysisLedger implements AnalysisCallLedger {
  private attempts = new Map<string, number>();
  constructor(private readonly store: PgAnalysisStore, private readonly lease: AnalysisLease) {}
  async responseId(stepId: string, id: string) {
    if (!id || id.length > 500) throw new AnalysisError("MODEL_INVALID_RESPONSE");
    await this.store.pool.query(`UPDATE marketing_analysis_steps SET receipt=$5,updated_at=now()
      WHERE analysis_id=$1 AND user_id=$2 AND step_id=$3 AND attempt=$4 AND receipt IS NULL`,
    [this.lease.id, this.lease.ownerId, stepId, this.attempts.get(stepId), JSON.stringify({ text: "", outcome: "request_unknown", responseId: id })]);
  }
  async begin(stepId: string, inputHash: string, model: string, images: number, inputTokenReserve = 32768) {
    return this.store.transaction(async client => {
      await ownerLock(client, this.lease.ownerId);
      const row = await this.store.leased(client, this.lease);
      const previous = (await client.query("SELECT * FROM marketing_analysis_steps WHERE analysis_id=$1 AND step_id=$2 ORDER BY attempt DESC LIMIT 1", [this.lease.id, stepId])).rows[0];
      if (previous) {
        if (previous.input_hash !== inputHash || previous.model !== model) throw new AnalysisError("MODEL_INPUT_CHANGED", 409);
        if (!previous.retry_requested) {
          this.attempts.set(stepId, previous.attempt);
          return (previous.receipt ?? { text: "", outcome: "request_unknown" }) as ModelStepReceipt;
        }
        if (previous.receipt?.outcome !== "failed" || !validReceiptUsage(previous.receipt)) throw new AnalysisError("REQUEST_UNKNOWN", 409);
      }
      const config = (row.pricing as ModelConfig[]).find(p => p.id === model);
      if (!config) throw new AnalysisError("ANALYSIS_PRICING_REQUIRED", 503);
      const reserve = calcCost(config, { inputCount: inputTokenReserve, outputCount: 8192 });
      const totals = (await client.query(`SELECT COALESCE(sum(CASE WHEN actual_cost IS NULL THEN reserved_cost ELSE actual_cost END),0) AS cost,
        COALESCE(sum(images) FILTER (WHERE model='deepseek-v4.1-flash'),0) AS ocr,
        COALESCE(sum(images) FILTER (WHERE model='kimi-k3'),0) AS visual FROM marketing_analysis_steps WHERE analysis_id=$1`, [row.id])).rows[0];
      if (Number(totals.cost) + reserve > Number(row.budget_limit) || !Number.isFinite(reserve) || reserve <= 0) throw new AnalysisError("ANALYSIS_BUDGET_EXHAUSTED", 402);
      if (Number(totals.ocr) + (model === "deepseek-v4.1-flash" ? images : 0) > ANALYSIS_LIMITS.ocrImages
        || Number(totals.visual) + (model === "kimi-k3" ? images : 0) > ANALYSIS_LIMITS.visualImages) throw new AnalysisError("ANALYSIS_IMAGE_BUDGET_EXHAUSTED", 402);
      await checkReservation(client, this.lease.ownerId, 0);
      const attempt = (previous?.attempt ?? 0) + 1;
      await client.query(`INSERT INTO marketing_analysis_steps(analysis_id,user_id,step_id,attempt,input_hash,model,images,reserved_cost)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, this.lease.ownerId, stepId, attempt, inputHash, model, images, reserve]);
      await client.query("UPDATE marketing_reference_analyses SET stage=$2,updated_at=now() WHERE id=$1", [row.id, stepId.split(":")[0]]);
      this.attempts.set(stepId, attempt);
      return null;
    });
  }
  async finish(stepId: string, receipt: ModelStepReceipt) {
    const attempt = this.attempts.get(stepId);
    if (!attempt) throw new AnalysisError("MODEL_INTENT_REQUIRED", 409);
    await this.store.transaction(async client => {
      await ownerLock(client, this.lease.ownerId);
      // A cancelled call may still return its usage. Keep it, but the lease
      // cannot publish subsequent work or a successful analysis.
      const row = await this.store.leased(client, this.lease, true);
      const step = (await client.query("SELECT * FROM marketing_analysis_steps WHERE analysis_id=$1 AND step_id=$2 AND attempt=$3 FOR UPDATE", [row.id, stepId, attempt])).rows[0];
      if (!step) throw new AnalysisError("MODEL_INTENT_REQUIRED", 409);
      if (step.actual_cost !== null && (step.receipt?.text !== receipt.text || step.receipt?.responseId !== receipt.responseId)) throw new AnalysisError("MODEL_RECEIPT_CONFLICT", 409);
      if (receipt.usage && !validReceiptUsage(receipt)) throw new AnalysisError("MODEL_USAGE_UNKNOWN", 409);
      const config = (row.pricing as ModelConfig[]).find(p => p.id === step.model)!;
      const cost = receipt.usage ? calcCost(config, { inputCount: receipt.usage.promptTokens, outputCount: receipt.usage.completionTokens }) : null;
      if (step.actual_cost !== null && cost !== Number(step.actual_cost)) throw new AnalysisError("MODEL_RECEIPT_CONFLICT", 409);
      await client.query("UPDATE marketing_analysis_steps SET receipt=$4,actual_cost=$5,updated_at=now() WHERE analysis_id=$1 AND step_id=$2 AND attempt=$3", [row.id, stepId, attempt, JSON.stringify(receipt), cost]);
      if (cost !== null && receipt.usage) {
        await client.query(`INSERT INTO usage_logs(user_id,task_id,model_id,model_type,input_count,output_count,total_cost,idempotency_key)
          VALUES($1,$2,$3,'llm',$4,$5,$6,$7) ON CONFLICT(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [this.lease.ownerId, row.id, step.model, receipt.usage.promptTokens, receipt.usage.completionTokens, cost, `media-analysis:${row.id}:${stepId}:${attempt}`]);
      }
      await client.query(`UPDATE marketing_reference_analyses SET spent=(SELECT COALESCE(sum(actual_cost),0) FROM marketing_analysis_steps WHERE analysis_id=$1),
        reserved_cost=GREATEST(0,budget_limit-(SELECT COALESCE(sum(actual_cost),0) FROM marketing_analysis_steps WHERE analysis_id=$1)) WHERE id=$1`, [row.id]);
    });
  }
}
