import { describe, expect, it, vi } from "vitest";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE } from "../models/digital-employee-llm.js";
import { AgentService } from "./agent-service.js";

function fakeService(catalogs: Record<string, string[]>) {
  const provider = { chat: vi.fn() };
  const fake: any = {
    db: {
      getUserApiKey: vi.fn(async () => "sk-active"),
      getUserApiKeys: vi.fn(async () => ["sk-active", "sk-empty", "sk-llm"]
        .map((apiKey) => ({ apiKey }))),
    },
    getUserModelCatalog: vi.fn(async () => ({
      llm: (catalogs["sk-active"] ?? []).map((id) => ({ id })),
      image: [],
      video: [],
    })),
    tokenhub: {
      listModels: vi.fn(async (apiKey: string) => ({
        llm: catalogs[apiKey] ?? [], image: [], video: [],
      })),
    },
    providerFactory: { llm: vi.fn(() => provider) },
    getLLMProvider: vi.fn(() => provider),
    resolveDigitalEmployeeLLM: (AgentService.prototype as any).resolveDigitalEmployeeLLM,
  };
  return fake;
}

describe("AgentService digital-employee LLM resolution", () => {
  it("uses a preferred LLM and key from the user's TokenHub keys", async () => {
    const fake = fakeService({
      "sk-llm": ["qwen3.7-max", "deepseek-v4-flash-selfhosted", "deepseek-v4-pro"],
    });

    const result = await (AgentService.prototype as any).resolveUtilityLLM.call(fake, {
      userId: "u1",
      digitalEmployee: true,
    });

    expect(result.usedModelId).toBe("deepseek-v4-pro");
    expect(result.modelIds).toEqual([
      "qwen3.7-max", "deepseek-v4-flash-selfhosted", "deepseek-v4-pro",
    ]);
    expect(fake.providerFactory.llm).toHaveBeenCalledWith("deepseek-v4-pro", "sk-llm");
    expect(fake.getLLMProvider).not.toHaveBeenCalled();
  });

  it("rejects instead of using the environment provider when every user key lacks an LLM", async () => {
    const fake = fakeService({});

    await expect((AgentService.prototype as any).resolveUtilityLLM.call(fake, {
      userId: "u1",
      digitalEmployee: true,
    })).rejects.toThrow(DIGITAL_EMPLOYEE_LLM_UNAVAILABLE);

    expect(fake.providerFactory.llm).not.toHaveBeenCalled();
    expect(fake.getLLMProvider).not.toHaveBeenCalled();
  });
});
