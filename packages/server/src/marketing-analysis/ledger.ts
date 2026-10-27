import type { AnalysisCallLedger, AnalysisLease, ModelStepReceipt } from "@lot-agent/core/marketing-analysis";
import { ANALYSIS_LIMITS } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";
import { PgAnalysisStore, ownerLock } from "./repository.js";
import { ANALYSIS_MODELS } from "./models.js";

/** Models whose steps count against the visual image limit: the current one, and earlier visual models
 * (the copy model read the frames until 2026-10-27), so an analysis that spans a change keeps its limit. */
const VISUAL_MODELS: string[] = [...new Set([ANALYSIS_MODELS.visual, "qwen3.8-max", "kimi-k3.1-pro", "kimi-k3"])];

export function validReceiptUsage(receipt: ModelStepReceipt) {
  return receipt.usage && [receipt.usage.promptTokens, receipt.usage.completionTokens].every(n => Number.isSafeInteger(n) && n >= 0);
}
/** An attempt that ended (failed with known usage, rejected, or got nothing back) and that the user resumed:
 * nothing of it can be replayed or double charged, so the next attempt may use another model or input. */
function settledRetry(row: { retry_requested: boolean; receipt: ModelStepReceipt | null }) {
  const outcome = row.receipt?.outcome;
  return row.retry_requested && (outcome === "rejected" || outcome === "cancelled" || (outcome === "failed" && !!validReceiptUsage(row.receipt!)));
}
/** Request intent and gateway receipts are committed in PG. Billing stays upstream.
 * Queue retries can only read the existing intent, never resubmit it. */
export class PgAnalysisLedger implements AnalysisCallLedger {
  private attempts = new Map<string, number>();
  constructor(private readonly store: PgAnalysisStore, private readonly lease: AnalysisLease) {}
  async responseId(stepId: string, id: string) {
    if (!id || id.length > 500) throw new AnalysisError("MODEL_INVALID_RESPONSE");
    await this.checkpoint(stepId, { responseId: id });
  }
  async requestId(stepId: string, id: string) {
    if (!id || id.length > 200) throw new AnalysisError("MODEL_INVALID_RESPONSE");
    await this.checkpoint(stepId, { gatewayRequestId: id });
  }
  /** Adds an identifier to an unfinished call; a finished receipt is left to `finish`. */
  private async checkpoint(stepId: string, ids: Pick<ModelStepReceipt, "responseId" | "gatewayRequestId">) {
    await this.store.pool.query(`UPDATE marketing_analysis_steps
      SET receipt=COALESCE(receipt,'{"text":"","outcome":"request_unknown"}'::jsonb) || $5::jsonb,updated_at=now()
      WHERE analysis_id=$1 AND user_id=$2 AND step_id=$3 AND attempt=$4
        AND (receipt IS NULL OR (receipt->>'outcome'='request_unknown' AND receipt->'usage' IS NULL AND COALESCE(receipt->>'text','')=''))`,
    [this.lease.id, this.lease.ownerId, stepId, this.attempts.get(stepId), JSON.stringify(ids)]);
  }
  /** The model a recorded step must keep; none for a new step or a settled, resumed one. */
  async stepModel(stepId: string): Promise<string | undefined> {
    const row = (await this.store.pool.query(`SELECT model,retry_requested,receipt FROM marketing_analysis_steps
      WHERE analysis_id=$1 AND user_id=$2 AND step_id=$3 ORDER BY attempt DESC LIMIT 1`, [this.lease.id, this.lease.ownerId, stepId])).rows[0];
    return row && !settledRetry(row) ? row.model : undefined;
  }
  async begin(stepId: string, inputHash: string, model: string, images: number) {
    return this.store.transaction(async client => {
      await ownerLock(client, this.lease.ownerId);
      const row = await this.store.leased(client, this.lease);
      const previous = (await client.query("SELECT * FROM marketing_analysis_steps WHERE analysis_id=$1 AND step_id=$2 ORDER BY attempt DESC LIMIT 1", [this.lease.id, stepId])).rows[0];
      if (previous) {
        if (previous.images !== images || ((previous.input_hash !== inputHash || previous.model !== model) && !settledRetry(previous))) {
          throw new AnalysisError("MODEL_INPUT_CHANGED", 409);
        }
        if (!previous.retry_requested) {
          this.attempts.set(stepId, previous.attempt);
          return (previous.receipt ?? { text: "", outcome: "request_unknown" }) as ModelStepReceipt;
        }
        const outcome = previous.receipt?.outcome;
        if (outcome !== "rejected" && outcome !== "cancelled" && (outcome !== "failed" || !validReceiptUsage(previous.receipt))) {
          throw new AnalysisError("REQUEST_UNKNOWN", 409);
        }
      }
      const totals = (await client.query(`SELECT
        COALESCE(sum(images) FILTER (WHERE model='deepseek-v4.1-flash'),0) AS ocr,
        COALESCE(sum(images) FILTER (WHERE model=ANY($2::text[])),0) AS visual FROM
        (SELECT DISTINCT ON (step_id) model,images FROM marketing_analysis_steps WHERE analysis_id=$1 ORDER BY step_id,attempt DESC) selected`,
        [row.id, VISUAL_MODELS])).rows[0];
      // This bounds selected image coverage, not paid attempts. An explicitly
      // resumed batch uses the same images and must not exhaust its own limit.
      const addedImages = previous ? 0 : images;
      if (Number(totals.ocr) + (model === "deepseek-v4.1-flash" ? addedImages : 0) > ANALYSIS_LIMITS.ocrImages
        || Number(totals.visual) + (VISUAL_MODELS.includes(model) ? addedImages : 0) > ANALYSIS_LIMITS.visualImages) throw new AnalysisError("ANALYSIS_IMAGE_BUDGET_EXHAUSTED", 422);
      const attempt = (previous?.attempt ?? 0) + 1;
      await client.query(`INSERT INTO marketing_analysis_steps(analysis_id,user_id,step_id,attempt,input_hash,model,images,reserved_cost)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id, this.lease.ownerId, stepId, attempt, inputHash, model, images, 0]);
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
      if (step.receipt && step.receipt.outcome !== "request_unknown"
        && (step.receipt.text !== receipt.text || step.receipt.responseId !== receipt.responseId
          || (step.receipt.usage?.promptTokens !== receipt.usage?.promptTokens || step.receipt.usage?.completionTokens !== receipt.usage?.completionTokens))) throw new AnalysisError("MODEL_RECEIPT_CONFLICT", 409);
      if (receipt.usage && !validReceiptUsage(receipt)) throw new AnalysisError("MODEL_USAGE_UNKNOWN", 409);
      await client.query("UPDATE marketing_analysis_steps SET receipt=$4,updated_at=now() WHERE analysis_id=$1 AND step_id=$2 AND attempt=$3", [row.id, stepId, attempt, JSON.stringify(receipt)]);
    });
  }
}
