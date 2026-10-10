import type { LLMProvider, ChatChunk } from "../types/index.js";
import { LLMResponseError } from "../llm/errors.js";
import type { RuntimeObservation } from "./run-state.js";

export class RunBudgetError extends Error {}

/** One budget shared by reasoning, compression and all provider retries. */
export class RunBudget {
  attempts = 0;
  inputTokens = 0;
  outputTokens = 0;
  cachedTokens = 0;
  cost = 0;
  constructor(private limits: {
    maxLlmAttempts: number; maxTotalTokens: number; maxCost?: number;
    tokenPrices?: { input: number; output: number };
  }, private observe?: (event: RuntimeObservation) => void) {}

  check(): void {
    if (this.attempts >= this.limits.maxLlmAttempts ||
      this.inputTokens + this.outputTokens >= this.limits.maxTotalTokens ||
      (this.limits.maxCost !== undefined && this.cost >= this.limits.maxCost)) {
      throw new RunBudgetError("Model request/token/cost budget exhausted");
    }
  }

  wrap(provider: LLMProvider): LLMProvider {
    const budget = this;
    return {
      async *chat(messages, tools, opts) {
        let attempt = 0;
        let reported = false;
        const onAttempt = () => {
          budget.check();
          attempt = ++budget.attempts;
          reported = false;
          budget.observe?.({ type: "llm_start", attempt, purpose: opts?.purpose ?? "reasoning" });
          opts?.onAttempt?.();
        };
        const onAttemptEnd = (error?: unknown) => {
          budget.observe?.({ type: "llm_end", attempt, failed: error !== undefined });
          opts?.onAttemptEnd?.(error);
        };
        const record = (usage: NonNullable<ChatChunk["usage"]>) => {
          if (reported) return;
          reported = true;
          budget.inputTokens += usage.promptTokens;
          budget.outputTokens += usage.completionTokens;
          budget.cachedTokens += usage.cachedPromptTokens ?? 0;
          const prices = budget.limits.tokenPrices;
          if (prices) budget.cost += (prices.input * usage.promptTokens + prices.output * usage.completionTokens) / 1000;
        };
        if (!provider.reportsAttempts) onAttempt();
        try {
          for await (const chunk of provider.chat(messages, tools, { ...opts, onAttempt, onAttemptEnd })) {
            if (chunk.type === "done" && chunk.usage) record(chunk.usage);
            yield chunk;
          }
          if (!provider.reportsAttempts) onAttemptEnd();
        } catch (error) {
          if (error instanceof LLMResponseError && error.usage) record(error.usage);
          if (!provider.reportsAttempts) onAttemptEnd(error);
          throw error;
        }
      },
    };
  }
}
