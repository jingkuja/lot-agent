import { describe, it, expect, vi } from "vitest";
import { AgentService } from "./agent-service.js";

/** generateTitle 的最小假 this:只带该方法用到的依赖。 */
function fakeService(overrides: { conversationModel?: string | null; apiKey?: string | null } = {}) {
  const chat = async function* () {
    yield { type: "text", content: "测试标题" };
  };
  const fake = {
    db: {
      getConversation: vi.fn(async () => ({
        id: "c1",
        title: "新对话",
        model: overrides.conversationModel ?? null,
      })),
      getMessages: vi.fn(async () => [{ role: "user" }]),
      getUserApiKey: vi.fn(async () => overrides.apiKey ?? null),
      updateConversationTitle: vi.fn(async () => {}),
    },
    llmConfig: { default: "m-env" },
    providerFactory: { llm: vi.fn(() => ({ chat })) },
    getLLMProvider: vi.fn(() => ({ chat })),
    generateTitle: AgentService.prototype.generateTitle,
  };
  return fake as unknown as AgentService & typeof fake;
}

describe("generateTitle model resolution", () => {
  it("explicit modelId wins over the conversation's stored model", async () => {
    const svc = fakeService({ conversationModel: "m-conv", apiKey: "key-1" });
    const title = await svc.generateTitle("c1", "你好", [], { userId: "u1", modelId: "m-explicit" });
    expect(title).toBe("测试标题");
    expect(svc.providerFactory.llm).toHaveBeenCalledWith("m-explicit", "key-1");
    expect(svc.getLLMProvider).not.toHaveBeenCalled();
  });

  it("falls back to the conversation's stored model", async () => {
    const svc = fakeService({ conversationModel: "m-conv", apiKey: "key-1" });
    await svc.generateTitle("c1", "你好", [], { userId: "u1" });
    expect(svc.providerFactory.llm).toHaveBeenCalledWith("m-conv", "key-1");
  });

  it("falls back to the env default model when nothing is stored", async () => {
    const svc = fakeService({ conversationModel: null, apiKey: "key-1" });
    await svc.generateTitle("c1", "你好", [], { userId: "u1" });
    expect(svc.providerFactory.llm).toHaveBeenCalledWith("m-env", "key-1");
  });

  it("uses the env provider when the user has no apiKey", async () => {
    const svc = fakeService({ conversationModel: "m-conv", apiKey: null });
    const title = await svc.generateTitle("c1", "你好", [], { userId: "u1" });
    expect(title).toBe("测试标题");
    expect(svc.providerFactory.llm).not.toHaveBeenCalled();
    expect(svc.getLLMProvider).toHaveBeenCalled();
  });

  it("uses the env provider when no opts are passed (legacy call)", async () => {
    const svc = fakeService({ conversationModel: "m-conv" });
    const title = await svc.generateTitle("c1", "你好");
    expect(title).toBe("测试标题");
    expect(svc.db.getUserApiKey).not.toHaveBeenCalled();
    expect(svc.providerFactory.llm).not.toHaveBeenCalled();
    expect(svc.getLLMProvider).toHaveBeenCalled();
  });
});
