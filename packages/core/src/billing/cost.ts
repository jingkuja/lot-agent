import type { ModelConfig } from "../models/types.js";

export interface UsageCounts {
  inputCount: number;
  outputCount: number;
}

/**
 * Total cost in 元.
 * LLM/embedding price is 元/千单位; others are 元/单位.
 */
export function calcCost(model: ModelConfig, usage: UsageCounts): number {
  if (model.type === "llm" || model.type === "embedding") {
    return (usage.inputCount * model.inputPrice + usage.outputCount * model.outputPrice) / 1000;
  }
  return usage.outputCount * model.unitPrice;
}

/**
 * Pre-flight cost estimate for a quota check / "费用预估" display — shares the
 * {@link calcCost} pricing basis so the 402 pre-check and the metered spend
 * never disagree. Counts are optional (LLM: estimated tokens; image: number of
 * images; video: number of seconds) and default to 0.
 */
export function estimateCost(
  model: ModelConfig,
  est: { inputCount?: number; outputCount?: number }
): number {
  return calcCost(model, {
    inputCount: est.inputCount ?? 0,
    outputCount: est.outputCount ?? 0,
  });
}
