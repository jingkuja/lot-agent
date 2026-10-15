import { describe, expect, it, vi } from "vitest";
import { LLMResponseError, OpenAIResponsesProvider, type ChatChunk } from "@lot-agent/core";
import { AgentService } from "./agent-service.js";

const usage = { promptTokens: 249, completionTokens: 3000 };
function setup(chunks: ChatChunk[], error?: unknown) {
  const chat = vi.fn(async function* () { for (const chunk of chunks) yield chunk; if (error) throw error; });
  const service = {
    usageMeter: { checkQuota: vi.fn().mockResolvedValue({ ok: true }) },
    miniprogram: { llm: "deepseek-v4.1-flash" },
    resolveUtilityLLM: vi.fn().mockResolvedValue({ llm: { chat }, usedModelId: "kimi-k3" }),
    meterUtilityUsage: vi.fn(),
  };
  const call = (signal?: AbortSignal) => AgentService.prototype.marketingText.call(service as unknown as AgentService, "Return review JSON", "现磨咖啡", "owner", signal);
  return { service, chat, call };
}

describe("marketing text completion", () => {
  it("uses Kimi with the owner's credentials in JSON mode and excludes thinking from the result", async () => {
    const f = setup([
      { type: "thinking", content: "private model reasoning" },
      { type: "text", content: '```json\n{"verdict":"pass","issues":[]}\n```' },
      { type: "done", finishReason: "stop", usage },
    ]);
    expect(await f.call()).toEqual({ verdict: "pass", issues: [] });
    expect(f.service.resolveUtilityLLM).toHaveBeenCalledWith({ userId: "owner", modelId: "kimi-k3" });
    expect(f.chat).toHaveBeenCalledWith(expect.any(Array), undefined, expect.objectContaining({ signal: expect.any(AbortSignal), params: { maxTokens: 8192, responseFormat: "json_object" } }));
    expect(f.service.meterUtilityUsage.mock.calls).toEqual([["marketing text", "kimi-k3", "owner", usage]]);
  });

  it("sends review JSON through Responses without the reasoning effort rejected by Kimi", async () => {
    const requests: Record<string, any>[] = [];
    const result = { verdict: "pass", issues: [] };
    const llm = new OpenAIResponsesProvider({ baseUrl: "https://gateway.test/v1", apiKey: "owner-key", model: "kimi-k3" }, {
      fetch: async (url, init) => {
        expect(new URL(String(url)).pathname).toBe("/v1/responses");
        const body = JSON.parse(String(init?.body)); requests.push(body);
        if (body.reasoning?.effort === "none") return new Response(JSON.stringify({ error: { message: "Invalid parameter: reasoning_effort must be low/high/max for kimi-k3, got none" } }), { status: 400, headers: { "Content-Type": "application/json" } });
        const event = { type: "response.completed", response: { id: "review-response", status: "completed", usage: { input_tokens: 20, output_tokens: 8 }, output: [
          { type: "message", id: "review-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] },
        ] } };
        return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const f = setup([]);
    f.service.resolveUtilityLLM.mockResolvedValueOnce({ llm, usedModelId: "kimi-k3" } as any);
    expect(await f.call()).toEqual(result);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "kimi-k3", max_output_tokens: 8192, text: { format: { type: "json_object" } } });
    expect(requests[0]).not.toHaveProperty("reasoning");
    expect(f.service.meterUtilityUsage).toHaveBeenCalledWith("marketing text", "kimi-k3", "owner", { promptTokens: 20, completionTokens: 8 });
  });

  it("rejects a fallback model before sending copy or storyboard requests", async () => {
    const f = setup([]);
    f.service.resolveUtilityLLM.mockResolvedValueOnce({ llm: { chat: f.chat }, usedModelId: "deepseek-v4.1-flash" });
    await expect(f.call()).rejects.toMatchObject({ code: "MARKETING_MODEL_AUTH", status: 503 });
    expect(f.chat).not.toHaveBeenCalled();
    expect(f.service.meterUtilityUsage).not.toHaveBeenCalled();
  });

  it.each(["", '{"verdict":"pass","issues":[]}', '{"verdict":'])('rejects exhausted output without retry, even when JSON looks complete: %s', async text => {
    const f = setup([
      { type: "thinking", content: "private reasoning" }, { type: "text", content: text },
      { type: "done", finishReason: "length", usage },
    ]);
    await expect(f.call()).rejects.toMatchObject({ code: "MARKETING_TEXT_TRUNCATED", status: 502 });
    expect(f.chat).toHaveBeenCalledOnce();
    expect(f.service.meterUtilityUsage.mock.calls).toEqual([["marketing text", "kimi-k3", "owner", usage]]);
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
    expect(f.service.meterUtilityUsage.mock.calls).toEqual([["marketing text", "kimi-k3", "owner", usage]]);
  });

  it("does not turn upstream credential errors into an expired app session", async () => {
    const f = setup([], Object.assign(new Error("secret upstream token"), { status: 401 }));
    await expect(f.call()).rejects.toMatchObject({ code: "MARKETING_MODEL_AUTH", status: 503 });
  });

  it("delegates creation billing to upstream while resolving the owner's model", async () => {
    const f = setup([{ type: "text", content: '{}' }, { type: "done", finishReason: "stop", usage }]);
    f.service.usageMeter.checkQuota.mockResolvedValue({ ok: false });
    await AgentService.prototype.marketingText.call(f.service as unknown as AgentService, "Create shots", "Reference", "owner", undefined, { upstreamBilling: true });
    expect(f.service.usageMeter.checkQuota).not.toHaveBeenCalled();
    expect(f.service.meterUtilityUsage).not.toHaveBeenCalled();
    expect(f.service.resolveUtilityLLM).toHaveBeenCalledWith({ userId: "owner", modelId: "kimi-k3" });
    const rejected = setup([], Object.assign(new Error("private upstream message"), { status: 402 }));
    await expect(AgentService.prototype.marketingText.call(rejected.service as unknown as AgentService, "Create", "Reference", "owner", undefined, { upstreamBilling: true })).rejects.toMatchObject({ status: 402 });
    expect(rejected.chat).toHaveBeenCalledOnce();
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

it("records pre-model authorization failure as rejected instead of an unknown paid call", async () => {
  const f = setup([]);
  f.service.resolveUtilityLLM.mockRejectedValueOnce(new Error("managed New API credential unavailable"));
  const onReceipt = vi.fn(async () => {});
  await expect(AgentService.prototype.marketingText.call(f.service as unknown as AgentService, "system", "input", "owner", undefined, { upstreamBilling: true, onReceipt }))
    .rejects.toMatchObject({ code: "MARKETING_MODEL_AUTH" });
  expect(onReceipt).toHaveBeenCalledWith({ text: "", outcome: "rejected" });
  expect(f.chat).not.toHaveBeenCalled();
});
