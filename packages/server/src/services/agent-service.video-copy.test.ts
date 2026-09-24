import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
function setup(text = JSON.stringify({ script: "镜头与旁白", mainTitle: "标题", subtitle: "副标题", publishTitle: "发布", tags: "#创作" })) {
  const chat = vi.fn(async function* () {
    yield { type: "text", content: text };
    yield { type: "done", usage: { promptTokens: 40, completionTokens: 80 } };
  });
  const service = {
    usageMeter: { checkQuota: vi.fn().mockResolvedValue({ ok: true }) },
    miniprogram: { llm: "copy-model" },
    resolveUtilityLLM: vi.fn().mockResolvedValue({ llm: { chat }, usedModelId: "copy-model" }),
    meterUtilityUsage: vi.fn(),
  };
  const call = () => AgentService.prototype.generateVideoCopy.call(service as any, "咖啡主题", "owner");
  return { service, call, chat };
}
describe("video copy generation", () => {
  it("uses the user's configured model, bounded output, and meters usage", async () => {
    const { service, call, chat } = setup();
    expect(await call()).toMatchObject({ script: "镜头与旁白", tags: "#创作" });
    expect(service.resolveUtilityLLM).toHaveBeenCalledWith({ userId: "owner", modelId: "copy-model" });
    expect(chat).toHaveBeenCalledWith(expect.any(Array), undefined, expect.objectContaining({ params: { maxTokens: 1600 } }));
    expect(service.meterUtilityUsage).toHaveBeenCalledWith("video copy", "copy-model", "owner", { promptTokens: 40, completionTokens: 80 });
  });
  it("meters invalid JSON output, but does not send it to the client", async () => {
    const { service, call } = setup("invalid json");
    await expect(call()).rejects.toThrow(); expect(service.meterUtilityUsage).toHaveBeenCalled();
  });
  it("does not call a model when quota is exhausted", async () => {
    const { service, call } = setup(); service.usageMeter.checkQuota.mockResolvedValue({ ok: false });
    await expect(call()).rejects.toThrow(); expect(service.resolveUtilityLLM).not.toHaveBeenCalled();
  });
});
