/** Shown when the upstream LLM returns HTTP 401 (quota-exhausted keys
 * currently come back as "无效的令牌" rather than a dedicated quota error). */
export const LLM_QUOTA_HINT =
  "积分余额不足，请检查剩余积分是否足够。可在左侧管理区打开「积分不足时使用灵渠 AI 余额」。";

export function isUnauthorizedLLMError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const rec = err as { status?: unknown; statusCode?: unknown };
    if (rec.status === 401 || rec.statusCode === 401) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b/.test(msg);
}

export function formatLLMError(err: unknown): string {
  if (isUnauthorizedLLMError(err)) return LLM_QUOTA_HINT;
  const raw = err instanceof Error ? err.message : String(err);
  return `LLM error: ${raw}`;
}
