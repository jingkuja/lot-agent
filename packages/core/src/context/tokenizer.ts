/**
 * Lightweight token estimator.
 * Uses a character-based heuristic (1 token ≈ 3.5 chars for Chinese, 4 chars for English).
 * Good enough for budget management without pulling in tiktoken.
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count CJK characters (roughly 1 token per char)
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  // Remaining characters (roughly 1 token per 4 chars)
  const remaining = text.length - cjk;
  return Math.ceil(cjk + remaining / 3.5);
}
