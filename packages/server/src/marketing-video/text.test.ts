import { expect, it, vi } from "vitest";
import { OpenAIProvider, type LLMProvider } from "@lot-agent/core";
import { completeMarketingJson, type MarketingTextReceipt } from "./text.js";

it("persists response identity and complete output before returning, even after browser disconnection", async () => {
  const controller = new AbortController(); const receipts: MarketingTextReceipt[] = [];
  const llm: LLMProvider = { async *chat(_messages, _tools, options) {
    options?.onResponseId?.("response-fixture");
    yield { type: "text", content: '{"value":"paid result"}' };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 2, completionTokens: 2 } };
    controller.abort();
  } };
  const result = await completeMarketingJson(llm, "system", "input", controller.signal, async receipt => { receipts.push(structuredClone(receipt)); });
  expect(result).toEqual({ value: "paid result" });
  expect(receipts[0]).toEqual({ text: "", outcome: "unknown", responseId: "response-fixture" });
  expect(receipts.at(-1)).toMatchObject({ outcome: "completed", text: '{"value":"paid result"}', responseId: "response-fixture" });
});

it("records interrupted calls as unknown, never as free failures", async () => {
  const receipts: MarketingTextReceipt[] = [];
  const llm: LLMProvider = { async *chat() { yield { type: "text", content: '{"partial":' }; throw new Error("connection lost"); } };
  await expect(completeMarketingJson(llm, "system", "input", undefined, async receipt => { receipts.push(structuredClone(receipt)); })).rejects.toMatchObject({ code: "MARKETING_MODEL_UNAVAILABLE" });
  expect(receipts.at(-1)).toMatchObject({ outcome: "unknown", text: '{"partial":' });
});

it("prevents hidden Chat Completions retries and records a gateway error as a plain failure", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Response('{"error":{"message":"fixture unavailable"}}', { status: 503, headers: { "Content-Type": "application/json", "X-Oneapi-Request-Id": "20261021100000fixture" } }));

  const receipts: MarketingTextReceipt[] = [];
  try {
    const llm = new OpenAIProvider({ model: "kimi-k3", apiKey: "fixture", baseUrl: "https://fixture.test/v1" });
    (llm as unknown as { client: { fetch: typeof globalThis.fetch } }).client.fetch = fetch;
    const outcome = completeMarketingJson(llm, "system", "input", undefined, async receipt => { receipts.push(structuredClone(receipt)); }).catch(error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ code: "MARKETING_MODEL_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledOnce();
    // No response reached us: cancelled, retryable, with the gateway's log ID kept for refund checks.
    expect(receipts.at(-1)).toMatchObject({ outcome: "cancelled", text: "", gatewayRequestId: "20261021100000fixture" });
  } finally { vi.useRealTimers(); }
});
