import { LLMResponseError, type LLMProvider } from "@lot-agent/core";

export interface MarketingTextReceipt {
  /** `cachedPromptTokens`: prompt tokens the gateway served from its prefix cache, when it reports them. */
  text: string; responseId?: string; usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number };
  /** The gateway's log ID (`x-oneapi-request-id`), to match a charge in its logs. */
  gatewayRequestId?: string;
  /** `cancelled`: sent, but nothing came back; not charged, and a charge in the gateway logs is refunded. */
  outcome: "completed" | "failed" | "unknown" | "rejected" | "cancelled";
}
export interface MarketingTextOptions { upstreamBilling?: boolean; onReceipt?: (receipt: MarketingTextReceipt) => Promise<void>; model?: string; }

export class MarketingTextError extends Error {
  constructor(message: string, readonly code: string, readonly status: 400 | 402 | 502 | 503 | 504 = 502) {
    super(message);
    this.name = "MarketingTextError";
  }
}

/** Never forward upstream bodies, prompts, partial JSON or credentials. */
export function marketingTextError(error: unknown, signal?: AbortSignal): MarketingTextError {
  if (error instanceof MarketingTextError) return error;
  if (signal?.aborted) {
    return signal.reason?.name === "TimeoutError"
      ? new MarketingTextError("文案处理超时，请稍后重试。", "MARKETING_TEXT_TIMEOUT", 504)
      : new MarketingTextError("文案处理已取消。", "MARKETING_TEXT_CANCELLED", 400);
  }
  const status = error && typeof error === "object" ? (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode : undefined;
  const upstream = error as { code?: string; error?: { code?: string } } | undefined;
  const quota = ["insufficient_quota", "insufficient_user_quota", "insufficient_balance"].includes(upstream?.code ?? upstream?.error?.code ?? "");
  if (status === 402 || ((status === 401 || status === 403) && quota)) return new MarketingTextError("上游余额不足，请充值后继续。", "MARKETING_MODEL_QUOTA", 402);
  if (status === 401 || status === 403 || (error instanceof Error && error.message === "managed New API credential unavailable")) {
    return new MarketingTextError("文案模型授权不可用，请检查账号的模型权限和积分后重试。", "MARKETING_MODEL_AUTH", 503);
  }
  if (status === 429) return new MarketingTextError("文案模型繁忙，请稍后重试。", "MARKETING_MODEL_BUSY", 503);
  return new MarketingTextError("文案模型暂时无法完成请求，请稍后重试。", "MARKETING_MODEL_UNAVAILABLE", 503);
}

export async function completeMarketingJson(llm: LLMProvider, system: string, input: string, signal?: AbortSignal, onReceipt?: MarketingTextOptions["onReceipt"]): Promise<unknown> {
  const timeout = AbortSignal.timeout(300_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let text = "";
  let completed = false;
  const receipt: MarketingTextReceipt = { text: "", outcome: "unknown" };
  let saved = false;
  let receiptWrites = Promise.resolve();
  let attempts = 0; let lastAttemptError: unknown;
  // Save each identifier as it arrives, so even a lost process leaves them on record.
  const checkpoint = () => {
    if (!onReceipt) return;
    receiptWrites = receiptWrites.then(() => onReceipt({ text: "", outcome: "unknown",
      ...(receipt.responseId ? { responseId: receipt.responseId } : {}), ...(receipt.gatewayRequestId ? { gatewayRequestId: receipt.gatewayRequestId } : {}) }));
    // Prevent an unhandled rejection while the stream is still active. The
    // original promise is awaited before publishing any complete receipt.
    void receiptWrites.catch(() => {});
  };
  try {
    requestSignal.throwIfAborted();
    // Kimi rejects reasoning.effort=none. Keep its default reasoning policy
    // instead of sending the generic "off" switch through the gateway.
    for await (const chunk of llm.chat([
      { role: "system", content: system }, { role: "user", content: input },
    ], undefined, { signal: requestSignal,
      onAttempt: () => {
        if (onReceipt && attempts++ > 0) throw lastAttemptError ?? new Error("MARKETING_REQUEST_UNKNOWN");
      },
      onAttemptEnd: error => { lastAttemptError = error; },
      params: { maxTokens: 8192, responseFormat: "json_object" },
      onResponseId: id => { receipt.responseId = id; checkpoint(); },
      onRequestId: id => { receipt.gatewayRequestId = id; checkpoint(); } })) {
      if (chunk.type === "text") text += chunk.content ?? "";
      if (text.length > 100_000) throw new Error("MODEL_OUTPUT_LIMIT");
      if (chunk.type === "done") {
        receipt.usage = chunk.usage; receipt.responseId = chunk.responseId ?? receipt.responseId;
        receipt.outcome = chunk.usage ? "failed" : "unknown";
        if (["length", "max_tokens"].includes(chunk.finishReason ?? "")) {
          throw new MarketingTextError("模型输出未完成，请重试；当前文案已保留。", "MARKETING_TEXT_TRUNCATED");
        }
        completed = ["stop", "end_turn", "stop_sequence"].includes(chunk.finishReason ?? "");
      }
    }
    // Once the full result arrives, commit it even if the browser disconnects.
    if (!completed) requestSignal.throwIfAborted();
    if (!completed || !text.trim()) {
      throw new MarketingTextError("模型未返回完整结果，请重试；当前文案已保留。", "MARKETING_TEXT_EMPTY");
    }
    receipt.text = text; receipt.outcome = receipt.usage ? "completed" : "unknown";
    await receiptWrites;
    if (onReceipt) { await onReceipt(receipt); saved = true; }
    // Accept a single Markdown fence from compatible providers, but never
    // repair truncated JSON or treat malformed output as a passing review.
    try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new MarketingTextError("模型返回的结果格式异常，请重试；当前文案已保留。", "MARKETING_TEXT_INVALID_JSON"); }
  } catch (error) {
    if (!saved && onReceipt) {
      await receiptWrites;
      receipt.text = text;
      if (error instanceof LLMResponseError && error.usage) { receipt.usage = error.usage; receipt.outcome = "failed"; }
      // Nothing came back: an explicit refusal (auth, quota, rate limit) is a plain rejection.
      // Any other error status, timeout or lost connection is "cancelled": not charged, the user
      // may retry, and the gateway request ID matches a rare charge for refund. Anything
      // received means the model ran: stay unknown.
      const status = (error as { status?: number })?.status;
      if (!text && !receipt.usage && !receipt.responseId) receipt.outcome = [401, 402, 403, 429].includes(status ?? 0) ? "rejected" : "cancelled";
      await onReceipt(receipt);
    }
    throw marketingTextError(error, requestSignal);
  }
}
