export type ProviderPhase = "create" | "poll" | "download";
export type ProviderErrorCode = "HTTP_ERROR" | "TRANSPORT_ERROR" | "INVALID_RESPONSE" | "TASK_FAILED";

/** No untrusted body, exception cause, prompt or URL is retained here. */
export class ProviderError extends Error {
  readonly name = "ProviderError";
  readonly requestId?: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  constructor(
    readonly provider: "generation" | "kling-voice",
    readonly phase: ProviderPhase,
    readonly code: ProviderErrorCode,
    options: { httpStatus?: number; requestId?: unknown; privateValues?: string[] } = {},
  ) {
    const status = Number.isInteger(options.httpStatus) && options.httpStatus! >= 100 && options.httpStatus! <= 599 ? options.httpStatus : undefined;
    const id = typeof options.requestId === "string" && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|req[-_][a-f0-9]{8,64})$/i.test(options.requestId)
      && !options.privateValues?.some(value => value && options.requestId === value) ? options.requestId : undefined;
    super(`${provider === "kling-voice" ? "Kling 音色" : "媒体供应商"}请求失败（${phase}，${code}${status ? `，HTTP ${status}` : ""}${id ? `，request_id: ${id}` : ""}）`);
    this.httpStatus = status;
    this.requestId = id;
    // Only reads may be retried. A failed POST can have an unknown outcome.
    this.retryable = phase !== "create" && code !== "TASK_FAILED";
  }
}
