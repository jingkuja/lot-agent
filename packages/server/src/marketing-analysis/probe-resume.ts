import type { ModelStepReceipt } from "@lot-agent/core/marketing-analysis";
import { AnalysisError } from "./errors.js";

/** Only an explicitly requested operator probe may leave known failed OCR
 * frames as gaps. Preserve their receipts and costs; never retry them or skip
 * an unresolved request. Production jobs retain their review/resume workflow. */
export function failedProbeOcrFrames(records: { stepId: string; receipt?: ModelStepReceipt }[], allowGaps: boolean): string[] {
  if (records.some(row => !row.receipt || row.receipt.outcome === "request_unknown")) throw new AnalysisError("REQUEST_UNKNOWN", 409);
  if (records.some(row => !row.receipt?.usage)) throw new AnalysisError("MODEL_USAGE_UNKNOWN", 409);
  const failed = records.filter(row => row.receipt?.outcome === "failed");
  if (failed.length && (!allowGaps || failed.some(row => !/^ocr:f\d{4}$/.test(row.stepId)))) throw new AnalysisError("MODEL_STEP_FAILED", 409);
  return failed.map(row => row.stepId.slice(4));
}
