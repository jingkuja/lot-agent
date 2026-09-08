/** Preferred LLMs for every digital-employee model call, in selection order. */
export const DIGITAL_EMPLOYEE_LLM_PRIORITY = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-selfhosted",
  "qwen3.7-max",
] as const;

export const DIGITAL_EMPLOYEE_LLM_UNAVAILABLE =
  "当前账号没有可用的 LLM 模型，请先为 TokenHub key 配置 LLM 模型权限";

export function pickDigitalEmployeeLlmModel(modelIds: string[]): string | null {
  if (modelIds.length === 0) return null;
  const available = new Set(modelIds);
  return DIGITAL_EMPLOYEE_LLM_PRIORITY.find((id) => available.has(id)) ?? modelIds[0]!;
}

export interface DigitalEmployeeLlmSelection {
  apiKey: string;
  modelId: string;
  modelIds: string[];
}

/**
 * Resolve a user-funded LLM for digital-employee work. The active key gets
 * first refusal. If a persisted/explicit model is requested, every user key is
 * checked for it before falling back to the preferred model of the first key
 * that exposes any LLM. Catalog failures are isolated per key.
 */
export async function resolveDigitalEmployeeLlm(
  activeApiKey: string | null,
  apiKeys: string[],
  listLlmModels: (apiKey: string) => Promise<string[]>,
  requestedModelId?: string | null
): Promise<DigitalEmployeeLlmSelection | null> {
  const candidates = [activeApiKey, ...apiKeys]
    .filter((key): key is string => typeof key === "string" && key.length > 0)
    .filter((key, index, keys) => keys.indexOf(key) === index);
  let fallback: DigitalEmployeeLlmSelection | null = null;

  for (const apiKey of candidates) {
    try {
      const modelIds = await listLlmModels(apiKey);
      if (requestedModelId && modelIds.includes(requestedModelId)) {
        return { apiKey, modelId: requestedModelId, modelIds };
      }
      if (!fallback) {
        const modelId = pickDigitalEmployeeLlmModel(modelIds);
        if (modelId) fallback = { apiKey, modelId, modelIds };
      }
      if (fallback && !requestedModelId) return fallback;
    } catch {
      // One invalid/unreachable key must not prevent trying the remaining keys.
    }
  }
  return fallback;
}
