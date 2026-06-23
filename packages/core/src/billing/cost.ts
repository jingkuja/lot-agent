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
