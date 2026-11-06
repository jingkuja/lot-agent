/** Shown when the upstream LLM returns HTTP 401 (quota-exhausted keys
 * currently come back as "无效的令牌" rather than a dedicated quota error). */
export const LLM_QUOTA_HINT =
  "积分余额不足，请检查剩余积分是否足够。可在左上角账号菜单中打开「积分不足时使用灵渠 AI 余额」。";

export function isUnauthorizedLLMError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const rec = err as { status?: unknown; statusCode?: unknown };
    if (rec.status === 401 || rec.statusCode === 401) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b/.test(msg);
}

const QUOTA_CODES = ["insufficient_quota", "insufficient_user_quota", "insufficient_balance"];

function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as { status?: unknown; statusCode?: unknown; httpStatus?: unknown };
  const status = rec.status ?? rec.statusCode ?? rec.httpStatus;
  return typeof status === "number" ? status : undefined;
}

/** The gateway refused because the account ran out of balance. A plain 401 is not enough to say so. */
export function isQuotaError(err: unknown): boolean {
  if (errorStatus(err) === 402) return true;
  if (!err || typeof err !== "object") return false;
  const rec = err as { code?: unknown; error?: { code?: unknown } };
  const code = rec.code ?? rec.error?.code;
  return typeof code === "string" && QUOTA_CODES.includes(code);
}

/**
 * What a caller needs to tell apart from an ordinary model failure. An exhausted key
 * currently comes back as a 401, so a 401 counts: pausing costs nothing, retrying cannot help.
 */
export function llmErrorCode(err: unknown): "quota" | undefined {
  return isQuotaError(err) || isUnauthorizedLLMError(err) ? "quota" : undefined;
}

export function formatLLMError(err: unknown): string {
  if (isUnauthorizedLLMError(err)) return LLM_QUOTA_HINT;
  const raw = err instanceof Error ? err.message : String(err);
  return `LLM error: ${raw}`;
}

/** Preserve known usage when the wire protocol fails after a paid generation. */
export class LLMResponseError extends Error {
  constructor(message: string, readonly usage?: import("../types/index.js").ChatChunk["usage"]) {
    super(message);
    this.name = "LLMResponseError";
  }
}

export class LLMIncompleteError extends Error {
  constructor(readonly finishReason: string, readonly partialText: string) {
    super(`LLM generation incomplete: ${finishReason}`);
    this.name = "LLMIncompleteError";
  }
}
