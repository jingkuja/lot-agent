import { describe, expect, it, vi } from "vitest";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE } from "./llm.js";
import { createOwnerLlmResolver } from "./runtime.js";

function fixture(catalogs: Record<string, string[]>, opts: { managed?: boolean; activeKey?: string | null } = {}) {
  const provider = { chat: vi.fn() };
  const llm = vi.fn(() => provider);
  const listLlmModels = vi.fn(async (_userId: string, apiKey: string) => catalogs[apiKey] ?? []);
  const resolve = createOwnerLlmResolver({
    db: {
      getUserApiKey: vi.fn(async () => opts.activeKey === undefined ? "sk-active" : opts.activeKey),
      getUserApiKeys: vi.fn(async () => ["sk-active", "sk-empty", "sk-llm"].map((apiKey) => ({ apiKey }))),
    } as never,
    managedKeysEnabled: opts.managed ?? false,
    listLlmModels,
    llm,
  });
  return { resolve, llm, listLlmModels };
}

describe("createOwnerLlmResolver", () => {
  it("uses a preferred LLM and key from the user's TokenHub keys", async () => {
    const { resolve, llm } = fixture({ "sk-llm": ["qwen3.7-max", "deepseek-v4-flash-selfhosted", "deepseek-v4-pro"] });
    const result = await resolve("u1");
    expect(result.usedModelId).toBe("deepseek-v4-pro");
    expect(result.modelIds).toEqual(["qwen3.7-max", "deepseek-v4-flash-selfhosted", "deepseek-v4-pro"]);
    expect(llm).toHaveBeenCalledWith("deepseek-v4-pro", "sk-llm");
  });

  it("marks the active key so the API can use its cached catalog", async () => {
    const { resolve, listLlmModels } = fixture({ "sk-active": ["deepseek-v4.1-flash"] });
    await resolve("u1");
    expect(listLlmModels).toHaveBeenCalledWith("u1", "sk-active", true);
  });

  it("rejects when every user key lacks an LLM", async () => {
    const { resolve, llm } = fixture({});
    await expect(resolve("u1")).rejects.toThrow(DIGITAL_EMPLOYEE_LLM_UNAVAILABLE);
    expect(llm).not.toHaveBeenCalled();
  });

  it("rejects without an owner", async () => {
    const { resolve, llm } = fixture({ "sk-active": ["deepseek-v4.1-flash"] });
    await expect(resolve(undefined)).rejects.toThrow(DIGITAL_EMPLOYEE_LLM_UNAVAILABLE);
    expect(llm).not.toHaveBeenCalled();
  });

  it("requires the managed credential when managed keys are on", async () => {
    const { resolve } = fixture({}, { managed: true, activeKey: null });
    await expect(resolve("u1")).rejects.toThrow("managed New API credential unavailable");
  });
});
