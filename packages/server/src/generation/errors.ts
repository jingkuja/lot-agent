/** A generation failure whose cause callers act on by code, never by message text. */
export type GenerationErrorCode = "CONFIG_MISSING" | "MODEL_AUTH_REQUIRED" | "GENERATION_FAILED" | "TIMED_OUT";

export class GenerationError extends Error {
  constructor(readonly errorCode: GenerationErrorCode, message: string) { super(message); }
}
