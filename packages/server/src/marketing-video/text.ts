import type { LLMProvider } from "@lot-agent/core";

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

export async function completeMarketingJson(llm: LLMProvider, system: string, input: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(300_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let text = "";
  let completed = false;
  try {
    requestSignal.throwIfAborted();
    // Kimi rejects reasoning.effort=none. Keep its default reasoning policy
    // instead of sending the generic "off" switch through the gateway.
    for await (const chunk of llm.chat([
      { role: "system", content: system }, { role: "user", content: input },
    ], undefined, { signal: requestSignal, params: { maxTokens: 8192, responseFormat: "json_object" } })) {
      if (chunk.type === "text") text += chunk.content ?? "";
      if (chunk.type === "done") {
        if (["length", "max_tokens"].includes(chunk.finishReason ?? "")) {
          throw new MarketingTextError("模型输出未完成，请重试；当前文案已保留。", "MARKETING_TEXT_TRUNCATED");
        }
        completed = ["stop", "end_turn", "stop_sequence"].includes(chunk.finishReason ?? "");
      }
    }
    requestSignal.throwIfAborted();
    if (!completed || !text.trim()) {
      throw new MarketingTextError("模型未返回完整结果，请重试；当前文案已保留。", "MARKETING_TEXT_EMPTY");
    }
    // Accept a single Markdown fence from compatible providers, but never
    // repair truncated JSON or treat malformed output as a passing review.
    try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new MarketingTextError("模型返回的结果格式异常，请重试；当前文案已保留。", "MARKETING_TEXT_INVALID_JSON"); }
  } catch (error) { throw marketingTextError(error, requestSignal); }
}
