/** A generation failure whose cause callers act on by code, never by message text. */
export type GenerationErrorCode = "CONFIG_MISSING" | "MODEL_AUTH_REQUIRED" | "GENERATION_FAILED" | "TIMED_OUT"
  | "MATERIAL_SYNC_PENDING" | "MATERIAL_SYNC_FAILED";

export const GENERATION_QUEUE_FAILED = "生成任务未能排队，请稍后重试";

export class GenerationError extends Error {
  constructor(readonly errorCode: GenerationErrorCode, message: string) { super(message); }
}
