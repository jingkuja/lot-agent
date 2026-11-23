import type { ChatOptions, LLMProvider } from "@lot-agent/core";
import { MARKETING_COPY_REASONING_EFFORT } from "@lot-agent/core/marketing-video";
import { COPY_MODEL_HOLD_MS, COPY_MODEL_ORDER, CopyModelSwitch, copyModelFault } from "../marketing-video/copy-model.js";
import { marketingTextError } from "../marketing-video/text.js";
import type { ResolvedLlm } from "../services/agent-extensions.js";
import { ComicLibraryError } from "./library-db.js";

export interface ComicDirectorLlmPorts {
  getUserApiKey(userId: string, managedKeysEnabled: boolean): Promise<string | null>;
  managedKeysEnabled: boolean;
  listLlmModels(userId: string, apiKey: string): Promise<string[]>;
  llm(modelId: string, apiKey: string): LLMProvider;
}

export const COMIC_DIRECTOR_LLM_UNAVAILABLE = "COMIC_DIRECTOR_LLM_UNAVAILABLE";

export type ComicDirectorLlm = ResolvedLlm & { failed?: () => void };

export function createComicDirectorModelPolicy() {
  const switches = new Map<string, CopyModelSwitch>();
  return (owner: string, available: readonly string[]) => {
    const models = COPY_MODEL_ORDER.filter(model => available.includes(model));
    if (!models.length) return null;
    let policy = switches.get(owner);
    if (!policy || models.length !== policy.models.length || models.some((model, i) => model !== policy?.models[i])) {
      policy = new CopyModelSwitch(models, COPY_MODEL_HOLD_MS, Date.now, "comic-director");
    }
    switches.delete(owner);
    if (switches.size >= 1024) switches.delete(switches.keys().next().value!);
    switches.set(owner, policy);
    return policy;
  };
}

export function createComicDirectorLlmResolver(ports: ComicDirectorLlmPorts, select = createComicDirectorModelPolicy()) {
  return async (userId: string | undefined): Promise<ComicDirectorLlm> => {
    if (!userId) throw new ComicLibraryError(COMIC_DIRECTOR_LLM_UNAVAILABLE, 503);
    const apiKey = await ports.getUserApiKey(userId, ports.managedKeysEnabled);
    if (!apiKey) throw new ComicLibraryError(COMIC_DIRECTOR_LLM_UNAVAILABLE, 503);
    const policy = select(userId, await ports.listLlmModels(userId, apiKey));
    if (!policy) throw new ComicLibraryError(COMIC_DIRECTOR_LLM_UNAVAILABLE, 503);
    const chosen = policy.current();
    return { usedModelId: chosen, modelIds: [...policy.models], llm: ports.llm(chosen, apiKey), failed: () => policy.failed(chosen) };
  };
}

export function comicDirectorChatOptions(model: string, signal: AbortSignal, params: ChatOptions["params"]): ChatOptions {
  const effort = MARKETING_COPY_REASONING_EFFORT[model];
  let attempted = false;
  let lastError: unknown;
  return {
    signal, params: { ...params, ...(effort ? { reasoningEffort: effort } : {}) },
    onAttempt: () => {
      if (attempted) throw lastError ?? new Error("DIRECTOR_DUPLICATE_ATTEMPT");
      attempted = true;
    },
    onAttemptEnd: error => { lastError = error; },
  };
}

export function comicDirectorModelFault(error: unknown, signal: AbortSignal, deadline: AbortSignal) {
  return !signal.aborted && copyModelFault(marketingTextError(error, deadline));
}
