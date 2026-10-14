import type { ClientOptions } from "openai";
import { describe, expect, it, vi } from "vitest";
import { mapResponsesStream, OpenAIResponsesProvider, toResponsesInput } from "./responses.js";
import { createLLMProvider } from "./factory.js";
import { LLMResponseError } from "./errors.js";
import type { ChatChunk, Message } from "../types/index.js";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

async function collect(stream: AsyncIterable<ChatChunk>) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
async function* events(values: unknown[]) { yield* values as ResponseStreamEvent[]; }
const usage = { input_tokens: 22, output_tokens: 7, input_tokens_details: { cached_tokens: 10 } };
const message = (text = "你好") => ({ type: "message", id: "msg1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const call = (id = "call1", args = '{"value":1}') => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "save", arguments: args, status: "completed" });
const terminal = (output: unknown[] = [message()], status = "completed", extra = {}) => ({ type: `response.${status}`, response: { id: "resp1", status, output, usage, ...extra } });

describe("Responses transport", () => {
  it("maps ordered images, tool calls and matching function outputs", () => {
    const input = toResponsesInput([
      { role: "system", content: "only visible evidence" },
      { role: "user", content: [{ type: "text", text: "f1 at 500ms" }, { type: "image", image: { url: "data:image/png;base64,AA==", mediaType: "image/png" } }, { type: "text", text: "f2 at 1000ms" }] },
      { role: "assistant", content: "", toolCalls: [{ id: "call1", name: "save", arguments: { value: 1 } }] },
      { role: "tool", content: "ok", toolCallId: "call1" },
    ], "kimi-k3");
    expect(input[1]).toMatchObject({ content: [{ type: "input_text", text: "f1 at 500ms" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }, { type: "input_text", text: "f2 at 1000ms" }] });
    expect(input[2]).toEqual({ type: "function_call", call_id: "call1", name: "save", arguments: '{"value":1}' });
    expect(input[3]).toEqual({ type: "function_call_output", call_id: "call1", output: "ok" });
  });

  it("replays encrypted reasoning only for the same model without duplicate tool items", () => {
    const items = [{ type: "reasoning", id: "rs1", summary: [], encrypted_content: "opaque" }, call()];
    const history: Message[] = [{ role: "assistant", content: "", toolCalls: [{ id: "call1", name: "save", arguments: {} }], responseState: { model: "m1", items } }];
    expect(toResponsesInput(history, "m1")).toEqual(items);
    expect(toResponsesInput(history, "m2")).toEqual([{ type: "function_call", call_id: "call1", name: "save", arguments: "{}" }]);
  });

  it("streams text once, preserves cached usage and emits one terminal", async () => {
    const onId = vi.fn();
    const chunks = await collect(mapResponsesStream(events([
      { type: "response.created", response: { id: "resp1" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "你" },
      terminal(),
    ]), "m", onId));
    expect(chunks.filter(c => c.type === "text").map(c => c.content).join("")).toBe("你好");
    expect(chunks.at(-1)).toMatchObject({ type: "done", finishReason: "stop", responseId: "resp1", usage: { promptTokens: 22, completionTokens: 7, cachedPromptTokens: 10 } });
    expect(onId).toHaveBeenCalledOnce(); expect(onId).toHaveBeenCalledWith("resp1");
  });

  it("uses completed output as authoritative when function deltas interleave", async () => {
    const chunks = await collect(mapResponsesStream(events([
      { type: "response.output_item.added", output_index: 0, item: { ...call(), arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"value":' },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{}' },
      terminal([call(), call("call2", "{}")]),
    ]), "m"));
    expect(chunks.filter(c => c.type === "tool_call").map(c => c.toolCall)).toEqual([{ id: "call1", name: "save", arguments: { value: 1 } }, { id: "call2", name: "save", arguments: {} }]);
    expect(chunks.at(-1)?.finishReason).toBe("tool_calls");
  });

  it.each(["max_output_tokens", "content_filter"])("never dispatches incomplete calls (%s)", async reason => {
    const chunks = await collect(mapResponsesStream(events([terminal([call()], "incomplete", { incomplete_details: { reason } })]), "m"));
    expect(chunks).toEqual([{ type: "done", finishReason: reason === "max_output_tokens" ? "length" : "content_filter", usage: { promptTokens: 22, completionTokens: 7, cachedPromptTokens: 10 } }]);
  });

  it("treats refusal as terminal failure, including mixed tool outputs", async () => {
    const m = { ...message(), content: [{ type: "refusal", refusal: "no" }] };
    const chunks = await collect(mapResponsesStream(events([terminal([m, call()])]), "m"));
    expect(chunks.some(c => c.type === "tool_call")).toBe(false);
    expect(chunks.at(-1)?.finishReason).toBe("content_filter");
  });

  it.each([[call(), call("call2", "{broken")], [call(), call()]].map(output => ({ output })))("validates all tools before yielding the first call", async ({ output }) => {
    const emitted: ChatChunk[] = [];
    await expect((async () => { for await (const chunk of mapResponsesStream(events([terminal(output as unknown[])]), "m")) emitted.push(chunk); })()).rejects.toBeInstanceOf(LLMResponseError);
    expect(emitted.some(c => c.type === "tool_call")).toBe(false);
  });

  it("preserves known usage on failed completion and rejects EOF without a terminal", async () => {
    await expect(collect(mapResponsesStream(events([terminal([], "failed")]), "m"))).rejects.toMatchObject({ usage: { promptTokens: 22, completionTokens: 7 } });
    await expect(collect(mapResponsesStream(events([{ type: "response.output_item.done", item: call() }]), "m"))).rejects.toThrow("before completion");
  });

  it("selects Responses explicitly through the shared factory", () => {
    expect(createLLMProvider({ default: "openai", openai: { model: "m", apiKey: "x", protocol: "responses" }, anthropic: { model: "unused", apiKey: "" } })).toBeInstanceOf(OpenAIResponsesProvider);
  });

  it("posts Responses wire format to /v1/responses with isolated credentials and no hidden retry", async () => {
    const requests: { path?: string; authorization?: string; body: any }[] = [];
    const transport = { fetch: (async (url, init) => {
      requests.push({ path: new URL(String(url)).pathname, authorization: new Headers(init?.headers as HeadersInit).get("authorization") ?? undefined, body: JSON.parse(String(init?.body)) });
      if (requests.length > 1) return new Response('{"error":{"message":"unavailable"}}', { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(`event: response.completed\ndata: ${JSON.stringify(terminal())}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }) as ClientOptions["fetch"] };
    const baseUrl = "https://gateway.test/v1/";
      const provider = new OpenAIResponsesProvider({ model: "kimi-k3", apiKey: "user-a", baseUrl }, transport);
      const onAttempt = vi.fn(); const onAttemptEnd = vi.fn();
      await collect(provider.chat([{ role: "user", content: "Return JSON" }], [{ name: "save", description: "save", parameters: { type: "object" } }], { params: { maxTokens: 1000, responseSchema: { type: "object" }, reasoning: "off" } }));
      await expect(collect(new OpenAIResponsesProvider({ model: "deepseek-v4.1-flash", apiKey: "user-b", baseUrl }, transport).chat([], undefined, { onAttempt, onAttemptEnd }))).rejects.toThrow();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ path: "/v1/responses", authorization: "Bearer user-a", body: { model: "kimi-k3", store: false, stream: true, max_output_tokens: 1000, text: { format: { type: "json_schema" } }, reasoning: { effort: "none" }, tools: [{ type: "function", name: "save", strict: false }] } });
      expect(requests[0].body).not.toHaveProperty("messages");
      expect(requests[0].body).not.toHaveProperty("thinking");
      expect(requests[1].authorization).toBe("Bearer user-b");
      expect(onAttempt).toHaveBeenCalledOnce(); expect(onAttemptEnd).toHaveBeenCalledOnce();
      const abort = new AbortController(); abort.abort();
      await expect(collect(provider.chat([], undefined, { signal: abort.signal }))).rejects.toThrow();
      expect(requests).toHaveLength(2);
  });
});
