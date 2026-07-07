import type { ModelCapabilities } from "./types.js";

/** Default context window when a model advertises no `contextWindow`. */
export const DEFAULT_CONTEXT_TOTAL = 120_000;

/** Reserve 10% of the window as safety margin (output tokens, token-estimate slack). */
const SAFETY_MARGIN = 0.9;

/**
 * Derive the `ContextManager` total-token budget from a model's advertised
 * context window, keeping a 10% safety margin. Returns `fallback` when the
 * model declares no usable `contextWindow`, so a 32K model no longer overflows
 * and a 200K model no longer wastes half its window on the hard-coded 120K.
 */
export function contextBudgetTotal(
  cap: ModelCapabilities | undefined,
  fallback: number = DEFAULT_CONTEXT_TOTAL
): number {
  const window = cap?.contextWindow;
  if (!window || window <= 0) return fallback;
  return Math.floor(window * SAFETY_MARGIN);
}
