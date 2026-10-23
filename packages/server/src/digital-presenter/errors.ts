/** A request the user can fix; the message is shown as is. */
export class PresenterError extends Error {
  constructor(message: string, readonly status: 400 | 402 | 404 | 409 | 503 = 400) { super(message); this.name = "PresenterError"; }
}

export const PRESENTER_FAILURE_CODES = ["JOB_BUSY", "NOT_RECOVERABLE", "INPUT_INVALID", "CONFIG_MISSING", "MODEL_AUTH_REQUIRED", "SUBMISSION_UNKNOWN", "STATUS_UNCONFIRMED",
  "GENERATION_FAILED", "REJECTED", "GATEWAY_FAILED", "TIMED_OUT", "DOWNLOAD_INCOMPLETE", "QUALITY_CHECK_FAILED", "COMPOSITION_FAILED", "UNKNOWN"] as const;
export type PresenterFailureCode = typeof PRESENTER_FAILURE_CODES[number];
export const isPresenterFailureCode = (value: unknown): value is PresenterFailureCode => (PRESENTER_FAILURE_CODES as readonly unknown[]).includes(value);

/** A worker failure; the queue stores `errorCode` beside the message for the UI. */
export class PresenterRunError extends Error {
  constructor(readonly errorCode: PresenterFailureCode, message: string, options?: { cause?: unknown }) { super(message, options); this.name = "PresenterRunError"; }
}

export const UNKNOWN_CLIP_MESSAGE = "有片段已提交给模型但结果未知，可能已经计费。请确认后重新提交这些片段，或联系客服核实。";
