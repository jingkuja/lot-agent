import { describe, expect, it, vi } from "vitest";
import { LLMResponseError, type ChatChunk } from "@lot-agent/core";
import { AgentService } from "./agent-service.js";

const usage = { promptTokens: 249, completionTokens: 3000 };
function setup(chunks: ChatChunk[], error?: unknown) {
  const chat = vi.fn(async function* () { for (const chunk of chunks) yield chunk; if (error) throw error; });
  const service = {
    usageMeter: { checkQuota: vi.fn().mockResolvedValue({ ok: true }) },
    miniprogram: { llm: "deepseek-v4.1-flash" },
    resolveUtilityLLM: vi.fn().mockResolvedValue({ llm: { chat }, usedModelId: "deepseek-v4.1-flash" }),
    meterUtilityUsage: vi.fn(),
  };
  const call = (signal?: AbortSignal) => AgentService.prototype.marketingText.call(service as unknown as AgentService, "Return review JSON", "现磨咖啡", "owner", signal);
  return { service, chat, call };
}

describe("marketing text completion", () => {
  it("uses the owner's model in JSON mode and excludes thinking from the result", async () => {
    const f = setup([
      { type: "thinking", content: "private model reasoning" },
      { type: "text", content: '```json\n{"verdict":"pass","issues":[]}\n```' },
      { type: "done", finishReason: "stop", usage },
    ]);
    expect(await f.call()).toEqual({ verdict: "pass", issues: [] });
    expect(f.service.resolveUtilityLLM).toHaveBeenCalledWith({ userId: "owner", modelId: "deepseek-v4.1-flash" });
    expect(f.chat).toHaveBeenCalledWith(expect.any(Array), undefined, expect.objectContaining({ signal: expect.any(AbortSignal), params: { maxTokens: 8192, reasoning: "off", responseFormat: "json_object" } }));
    expect(f.service.meterUtilityUsage.mock.calls).toEqual([["marketing text", "deepseek-v4.1-flash", "owner", usage]]);
  });

  it.each(["", '{"verdict":"pass","issues":[]}', '{"verdict":'])('rejects exhausted output without retry, even when JSON looks complete: %s', async text => {
    const f = setup([
      { type: "thinking", content: "private reasoning" }, { type: "text", content: text },
      { type: "done", finishReason: "length", usage },
    ]);
    await expect(f.call()).rejects.toMatchObject({ code: "MARKETING_TEXT_TRUNCATED", status: 502 });
    expect(f.chat).toHaveBeenCalledOnce();
    expect(f.service.meterUtilityUsage.mock.calls).toEqual([["marketing text", "deepseek-v4.1-flash", "owner", usage]]);
  });

  it.each([
    { text: "  ", code: "MARKETING_TEXT_EMPTY" },
    { text: "private invalid response", code: "MARKETING_TEXT_INVALID_JSON" },
  ])("returns an actionable error for $code without leaking content", async ({ text, code }) => {
    const f = setup([{ type: "text", content: text }, { type: "done", finishReason: "stop", usage }]);
    await expect(f.call()).rejects.toMatchObject({ code, message: expect.stringContaining("当前文案已保留") });
    expect(f.service.meterUtilityUsage).toHaveBeenCalledOnce();
  });

  it("does not accept a stream without a completion marker", async () => {
    await expect(setup([{ type: "text", content: '{}' }]).call()).rejects.toMatchObject({ code: "MARKETING_TEXT_EMPTY" });
  });

  it("preserves known usage when the stream fails and keeps upstream details private", async () => {
    const f = setup([], new LLMResponseError("secret upstream body", usage));
    await expect(f.call()).rejects.toMatchObject({ code: "MARKETING_MODEL_UNAVAILABLE", message: "文案模型暂时无法完成请求，请稍后重试。" });
    expect(f.service.meterUtilityUsage.mock.calls).toEqual([["marketing text", "deepseek-v4.1-flash", "owner", usage]]);
  });

  it("does not turn upstream credential errors into an expired app session", async () => {
    const f = setup([], Object.assign(new Error("secret upstream token"), { status: 401 }));
    await expect(f.call()).rejects.toMatchObject({ code: "MARKETING_MODEL_AUTH", status: 503 });
  });

  it("stops before model selection on a quota failure or cancellation", async () => {
    const f = setup([]); f.service.usageMeter.checkQuota.mockResolvedValueOnce({ ok: false });
    await expect(f.call()).rejects.toMatchObject({ code: "MARKETING_USAGE_LIMIT", status: 402 });
    await expect(f.call(AbortSignal.abort())).rejects.toMatchObject({ code: "MARKETING_TEXT_CANCELLED" });
    expect(f.service.resolveUtilityLLM).not.toHaveBeenCalled();
  });

  it("propagates cancellation while the provider is waiting", async () => {
    const f = setup([]), controller = new AbortController();
    f.chat.mockImplementation(async function* (...args: any[]) {
      const signal = args[2].signal as AbortSignal;
      controller.abort();
      signal.throwIfAborted();
    });
    await expect(f.call(controller.signal)).rejects.toMatchObject({ code: "MARKETING_TEXT_CANCELLED" });
    expect(f.chat).toHaveBeenCalledOnce();
  });
});
