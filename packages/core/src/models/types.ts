export type ModelType = "llm" | "image" | "video" | "tts" | "asr" | "embedding" | "review";
export type BillingUnit = "token" | "image" | "second" | "character" | "request";

/**
 * What a model can do / how big it is. All fields optional so existing configs
 * stay valid; consumers fall back to conservative defaults when absent.
 */
export interface ModelCapabilities {
  contextWindow?: number;    // tokens; ContextManager.total derives from this
  maxOutputTokens?: number;  // default for ChatParams.maxTokens
  vision?: boolean;          // accepts image ContentParts
  toolUse?: boolean;         // when false, the Agent disables tools instead of erroring
  reasoning?: boolean;       // supports a thinking/reasoning budget
}

export interface ModelConfig {
  id: string;
  type: ModelType;
  provider: string;
  billingUnit: BillingUnit;
  inputPrice: number;   // 元/单位 (LLM input; 0 for non-LLM)
  outputPrice: number;  // 元/单位 (LLM output; 0 for non-LLM)
  unitPrice: number;    // 元/单位 for non-LLM (per image/second/...); 0 for LLM
  enabled: boolean;
  capabilities?: ModelCapabilities;
}

export interface ListModelsOptions {
  /** Include `enabled: false` models (operations can list them; users can't). */
  includeDisabled?: boolean;
}

export interface ModelRegistry {
  register(cfg: ModelConfig, factory: () => unknown): void;
  getConfig(id: string): ModelConfig | undefined; // returns disabled models too (pricing lookups)
  list(type?: ModelType, opts?: ListModelsOptions): ModelConfig[]; // hides disabled by default
  getProvider<T = unknown>(id: string): T | undefined; // lazy singleton; undefined if disabled
}
