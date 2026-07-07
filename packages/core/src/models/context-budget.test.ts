import { describe, it, expect } from "vitest";
import { contextBudgetTotal } from "./context-budget.js";

describe("contextBudgetTotal", () => {
  it("derives from contextWindow with a 10% safety margin", () => {
    expect(contextBudgetTotal({ contextWindow: 200_000 })).toBe(180_000);
    expect(contextBudgetTotal({ contextWindow: 128_000 })).toBe(115_200);
  });

  it("falls back to the default when capabilities are absent", () => {
    expect(contextBudgetTotal(undefined)).toBe(120_000);
  });

  it("falls back when capabilities has no contextWindow", () => {
    expect(contextBudgetTotal({ vision: true })).toBe(120_000);
  });

  it("honours a custom fallback", () => {
    expect(contextBudgetTotal(undefined, 64_000)).toBe(64_000);
    expect(contextBudgetTotal({ contextWindow: 0 }, 64_000)).toBe(64_000);
  });
});
