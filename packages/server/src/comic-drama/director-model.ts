import type { LLMProvider } from "@lot-agent/core";
import type { ResolvedLlm } from "../services/agent-extensions.js";
import type { PgComicSettings } from "./settings-repository.js";

export interface ComicDirectorLlmPorts {
  getUserApiKey(userId: string, managedKeysEnabled: boolean): Promise<string | null>;
  managedKeysEnabled: boolean;
  /** Returns ordered user LLM model IDs matching the platform's default LLM ordering. */
  listLlmModels(userId: string, apiKey: string): Promise<string[]>;
  llm(modelId: string, apiKey: string): LLMProvider;
  settings?: Pick<PgComicSettings, "getPreferences">;
}

export const COMIC_DIRECTOR_LLM_UNAVAILABLE = "COMIC_DIRECTOR_LLM_UNAVAILABLE";

/**
 * Resolves the director's text model using the user's own gateway key and default LLM policy:
 * 1. Explicit requested model (if available in the user's catalog)
 * 2. User's saved comic-drama defaultTextModel preference (if available in the user's catalog)
 * 3. First model in the user's ordered LLM catalog (matching platform default LLM strategy)
 */
export function createComicDirectorLlmResolver(ports: ComicDirectorLlmPorts) {
  return async (userId: string | undefined, requested?: string | null): Promise<ResolvedLlm> => {
    if (!userId) throw new Error(COMIC_DIRECTOR_LLM_UNAVAILABLE);
    const apiKey = await ports.getUserApiKey(userId, ports.managedKeysEnabled);
    if (!apiKey) throw new Error(COMIC_DIRECTOR_LLM_UNAVAILABLE);
    const modelIds = await ports.listLlmModels(userId, apiKey);
    if (!modelIds.length) throw new Error(COMIC_DIRECTOR_LLM_UNAVAILABLE);
    const preferred = requested
      ?? (ports.settings ? (await ports.settings.getPreferences(userId).catch(() => null))?.defaultTextModel ?? null : null);
    const chosen = preferred && modelIds.includes(preferred) ? preferred : modelIds[0]!;
    return {
      usedModelId: chosen,
      modelIds,
      llm: ports.llm(chosen, apiKey),
    };
  };
}
