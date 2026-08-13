import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";

function fakeService(opts: { apiKey?: string | null; catalog?: string[] } = {}) {
  const chat = async function* () {
    yield { type: "text", content: "2026 年差旅住宿报销标准" };
    yield { type: "done", usage: { promptTokens: 8, completionTokens: 5 } };
  };
  const fake: any = {
    db: { getUserApiKey: vi.fn(async () => opts.apiKey ?? null) },
    llmConfig: {
      default: "openai",
      openai: { model: "m-env" },
      anthropic: { model: "m-env-anthropic" },
    },
    getUserModelCatalog: vi.fn(async () => ({
      llm: (opts.catalog ?? []).map((id) => ({ id })), image: [], video: [],
    })),
    providerFactory: { llm: vi.fn(() => ({ chat })) },
    getLLMProvider: vi.fn(() => ({ chat })),
    usageMeter: { record: vi.fn(async () => 0) },
    resolveUtilityLLM: (AgentService.prototype as any).resolveUtilityLLM,
    meterUtilityUsage: (AgentService.prototype as any).meterUtilityUsage,
    rewriteKnowledgeQuery: AgentService.prototype.rewriteKnowledgeQuery,
  };
  return fake;
}

describe("rewriteKnowledgeQuery", () => {
  it("uses the explicit conversation model and meters the rewrite", async () => {
    const service = fakeService({ apiKey: "sk-user", catalog: ["m-catalog"] });
    await expect(service.rewriteKnowledgeQuery("今年出差住酒店能报多少？", {
      userId: "u1",
      modelId: "m-selected",
    })).resolves.toBe("2026 年差旅住宿报销标准");
    expect(service.providerFactory.llm).toHaveBeenCalledWith("m-selected", "sk-user");
    expect(service.getUserModelCatalog).not.toHaveBeenCalled();
    expect(service.usageMeter.record).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      modelId: "m-selected",
      usage: { inputCount: 8, outputCount: 5 },
    }));
  });

  it("falls back to the first catalog model like title generation", async () => {
    const service = fakeService({ apiKey: "sk-user", catalog: ["m-first", "m-second"] });
    await service.rewriteKnowledgeQuery("报销多少", { userId: "u1" });
    expect(service.providerFactory.llm).toHaveBeenCalledWith("m-first", "sk-user");
  });
});
