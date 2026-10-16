export const UNKNOWN_SUBMISSION = "marketing-submission-unknown";
export const UNKNOWN_SUBMISSION_MESSAGE = "片段提交结果未知，请核实原任务；系统不会重复提交付费请求。";

export interface RecoverableSegment {
  vendor_task_id?: string | null;
  output?: { assetIds?: string[]; retrySafe?: boolean } | null;
}

/** Classify before preflight or billing. Unknown always wins over retry flags. */
export function segmentRecoveryAction(segment: RecoverableSegment): "reuse" | "poll" | "submit" | "unknown" {
  if (segment.vendor_task_id === UNKNOWN_SUBMISSION) return "unknown";
  if (segment.output?.retrySafe === true) return "submit";
  if (segment.output?.assetIds?.length) return "reuse";
  return segment.vendor_task_id ? "poll" : "submit";
}
