export type ModelType = "llm" | "image" | "video" | "tts" | "asr" | "embedding" | "review";
export type BillingUnit = "token" | "image" | "second" | "character" | "request";

export interface ModelConfig {
  id: string;
  type: ModelType;
  provider: string;
  billingUnit: BillingUnit;
  inputPrice: number;   // 元/单位 (LLM input; 0 for non-LLM)
  outputPrice: number;  // 元/单位 (LLM output; 0 for non-LLM)
  unitPrice: number;    // 元/单位 for non-LLM (per image/second/...); 0 for LLM
  enabled: boolean;
}

export interface ModelRegistry {
  register(cfg: ModelConfig, factory: () => unknown): void;
  getConfig(id: string): ModelConfig | undefined;
  list(type?: ModelType): ModelConfig[];
  getProvider<T = unknown>(id: string): T | undefined; // lazy singleton instantiation
}
