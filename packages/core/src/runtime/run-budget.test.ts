import { describe, expect, it } from "vitest";
import { RunBudget, RunBudgetError } from "./run-budget.js";
import type { RuntimeObservation } from "./run-state.js";
import type { LLMProvider } from "../types/index.js";

describe("shared model budget", () => {
  it.each([{ maxTotalTokens: 30 }, { maxCost: 0.03 }])("counts compression against the same usage/cost limit: %o", async (limit) => {
    const observations: RuntimeObservation[] = [];
    const budget = new RunBudget({ maxLlmAttempts: 10, maxTotalTokens: 1000,
      tokenPrices: { input: 1, output: 1 }, ...limit }, event => observations.push(event));
    const provider: LLMProvider = { async *chat() {
      yield { type: "done", usage: { promptTokens: 10, completionTokens: 5 } };
    } };
    const reasoning = budget.wrap(provider);
    const compression = budget.wrap(provider);
    for await (const _chunk of reasoning.chat([], [])) { /* consume usage */ }
    for await (const _chunk of compression.chat([], [], { purpose: "compression" })) { /* consume usage */ }
    const next = reasoning.chat([], [])[Symbol.asyncIterator]();
    await expect(next.next()).rejects.toBeInstanceOf(RunBudgetError);
    expect(budget.attempts).toBe(2);
    expect(budget.inputTokens + budget.outputTokens).toBe(30);
    expect(budget.cost).toBeCloseTo(0.03);
    expect(observations.filter(event => event.type === "llm_start").map(event => event.purpose))
      .toEqual(["reasoning", "compression"]);
  });
});
