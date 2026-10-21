export type ProviderPhase = "create" | "poll" | "download";
/** CONNECT_ERROR: the connection failed before any request byte was sent. */
export type ProviderErrorCode = "HTTP_ERROR" | "TRANSPORT_ERROR" | "CONNECT_ERROR" | "INVALID_RESPONSE" | "TASK_FAILED" | "REAL_PERSON_REJECTED";

/** No untrusted body, exception cause, prompt or URL is retained here. */
export class ProviderError extends Error {
  readonly name = "ProviderError";
  readonly requestId?: string;
  readonly httpStatus?: number;
  /** The gateway's or vendor's fixed error identifier (e.g. `invalid_request`), for logs only. */
  readonly vendorCode?: string;
  readonly retryable: boolean;
  constructor(
    readonly provider: "generation" | "kling-voice" | "qwen-voice" | "speech",
    readonly phase: ProviderPhase,
    readonly code: ProviderErrorCode,
    options: { httpStatus?: number; requestId?: unknown; vendorCode?: unknown; privateValues?: string[] } = {},
  ) {
    const status = Number.isInteger(options.httpStatus) && options.httpStatus! >= 100 && options.httpStatus! <= 599 ? options.httpStatus : undefined;
    const id = typeof options.requestId === "string" && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|req[-_][a-f0-9]{8,64})$/i.test(options.requestId)
      && !options.privateValues?.some(value => value && options.requestId === value) ? options.requestId : undefined;
    const summary = code === "REAL_PERSON_REJECTED"
      ? "参考图包含真人，需先完成真人认证"
      : `${provider === "kling-voice" ? "Kling 音色" : provider === "qwen-voice" ? "千问音色" : provider === "speech" ? "语音合成" : "媒体供应商"}请求失败`;
    super(`${summary}（${phase}，${code}${status ? `，HTTP ${status}` : ""}${id ? `，request_id: ${id}` : ""}）`);
    this.httpStatus = status;
    this.requestId = id;
    // Identifiers only: free text could echo prompts, URLs or credentials.
    if (typeof options.vendorCode === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(options.vendorCode)) this.vendorCode = options.vendorCode;
    // Only reads may be retried. A failed POST can have an unknown outcome.
    this.retryable = phase !== "create" && code !== "TASK_FAILED" && code !== "REAL_PERSON_REJECTED";
  }
}
