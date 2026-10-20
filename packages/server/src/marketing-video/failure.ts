import { ProviderError } from "@lot-agent/core";
import type { MarketingFailureCode } from "@lot-agent/core/marketing-video";
import { GenerationError } from "../generation/errors.js";

/** A worker failure with its cause attached. `errorCode` is stored on the task. */
export class MarketingRunError extends Error {
  constructor(readonly errorCode: MarketingFailureCode, message: string, options?: { cause?: unknown }) { super(message, options); }
}

/** Classify by error type and provider fields, never by message text. */
export function marketingFailureCode(error: unknown): MarketingFailureCode {
  if (error instanceof MarketingRunError || error instanceof GenerationError) return error.errorCode;
  if (error instanceof ProviderError) {
    if (error.code === "REAL_PERSON_REJECTED") return "REAL_PERSON_REJECTED";
    if (error.code === "CONNECT_ERROR") return "CONNECT_FAILED";
    if (error.httpStatus === 401 || error.httpStatus === 403) return "MODEL_AUTH_REQUIRED";
    if (error.httpStatus === 402) return "MODEL_QUOTA";
    if (error.httpStatus === 429) return "MODEL_RATE_LIMIT";
    if (error.phase === "download") return "DOWNLOAD_INCOMPLETE";
    if (error.code === "TASK_FAILED") return "GENERATION_FAILED";
    if (error.phase === "poll") return "STATUS_UNCONFIRMED";
  }
  return "GENERATION_FAILED";
}
