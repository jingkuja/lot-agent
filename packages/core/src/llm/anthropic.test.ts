import { afterEach, describe, it, expect, vi } from "vitest";
import { AnthropicProvider, isAnthropicModel, mapAnthropicStream, toAnthropicConversation } from "./anthropic.js";
import { LLMResponseError } from "./errors.js";
import type { ChatChunk, ChatParams, Message } from "../types/index.js";

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function eventStream(events: unknown[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

describe("mapAnthropicStream", () => {
  it("accumulates usage from message_start + message_delta into the done chunk", async () => {
    const events = eventStream([
      { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 20 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]);
    const out = await collect(mapAnthropicStream(events));
    expect(out).toContainEqual({ type: "text", content: "hi" });
    const done = out.find((c) => c.type === "done");
    // promptTokens is the FULL input incl. cache-read (matching OpenAI's
    // prompt_tokens semantics, so billing counts cached tokens at full price);
    // cachedPromptTokens is the cached subset, for observability only.
    expect(done?.usage).toEqual({ promptTokens: 120, completionTokens: 8, cachedPromptTokens: 20 });
  });

  it("folds cache_creation_input_tokens into the billed prompt token count", async () => {
    const events = eventStream([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 30,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]);
    const out = await collect(mapAnthropicStream(events));
    const done = out.find((c) => c.type === "done");
    // 100 (uncached) + 20 (cache read) + 30 (cache write) = 150 billed input.
    expect(done?.usage).toEqual({ promptTokens: 150, completionTokens: 8, cachedPromptTokens: 20 });
  });

  it("maps thinking_delta to a thinking chunk", async () => {
    const events = eventStream([
      { type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm..." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const out = await collect(mapAnthropicStream(events));
    expect(out).toContainEqual({ type: "thinking", content: "hmm..." });
  });

  it("routes input_json_delta fragments to the correct tool_use block by index, even interleaved", async () => {
    const events = eventStream([
      { type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "read_file" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "list_files" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path"' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"."}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const out = await collect(mapAnthropicStream(events));
    const calls = out.filter((c) => c.type === "tool_call");
    expect(calls).toContainEqual({
      type: "tool_call",
      toolCall: { id: "t0", name: "read_file", arguments: { path: "a.txt" } },
    });
    expect(calls).toContainEqual({
      type: "tool_call",
      toolCall: { id: "t1", name: "list_files", arguments: { path: "." } },
    });
  });
});

function sse(events: Array<Record<string, unknown>>, headers: Record<string, string> = {}): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream", ...headers } });
}

const textReply = [
  { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

const thinkingToolReply = [
  { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "search" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"a"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
  { type: "message_stop" },
];

function gateway(reply: () => Response = () => sse(textReply)) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
  const provider = (model: string) => new AnthropicProvider({ apiKey: "user-key", baseUrl: "https://gw.test/v1/", model, fetch: fetcher });
  const body = (call = 0) => JSON.parse(String(fetcher.mock.calls[call][1]?.body));
  return { fetcher, provider, body };
}

const user: Message[] = [{ role: "user", content: "hi" }];

describe("isAnthropicModel", () => {
  it.each(["claude-opus-5-5", "Claude-Sonnet-5-5", "fable-5.1", "opus-4.8", "my-sonnet"])("routes %s to Messages", (id) => {
    expect(isAnthropicModel(id)).toBe(true);
  });
  it.each(["deepseek-v4.1-flash", "kimi-k3.1-pro", "qwen3.8-max", "gpt-5"])("leaves %s on the OpenAI transports", (id) => {
    expect(isAnthropicModel(id)).toBe(false);
  });
});

describe("AnthropicProvider request", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("posts to the gateway Messages route with only the user's key", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "host-token");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sse(textReply, { "x-oneapi-request-id": "req-1" }));
    const provider = new AnthropicProvider({
      apiKey: "user-key", baseUrl: "https://gw.test/v1", model: "claude-opus-5-5", headers: { "X-Agent-Globle": "1" }, fetch: fetcher,
    });
    const requestIds: string[] = [];
    const responseIds: string[] = [];
    const out = await collect(provider.chat(user, undefined, { onRequestId: (id) => requestIds.push(id), onResponseId: (id) => responseIds.push(id) }));

    expect(String(fetcher.mock.calls[0][0])).toBe("https://gw.test/v1/messages");
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("x-api-key")).toBe("user-key");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-agent-globle")).toBe("1");
    expect(requestIds).toEqual(["req-1"]);
    expect(responseIds).toEqual(["msg_1"]);
    expect(out.find((c) => c.type === "done")).toMatchObject({ finishReason: "stop", responseId: "msg_1" });
  });

  it("never sends sampling parameters", async () => {
    const { provider, body } = gateway();
    await collect(provider("claude-haiku-4-5").chat(user, undefined, { params: { temperature: 0.2, topP: 0.9 } }));
    expect(body()).not.toHaveProperty("temperature");
    expect(body()).not.toHaveProperty("top_p");
  });

  it.each<[string, ChatParams, Record<string, unknown>]>([
    ["claude-opus-5-5", {}, { thinking: { type: "adaptive", display: "summarized" }, max_tokens: 64_000 }],
    ["claude-fable-5-1", { reasoning: "off", maxTokens: 320 }, { output_config: { effort: "low" }, max_tokens: 4096 }],
    ["claude-opus-5-5", { reasoning: "off" }, { output_config: { effort: "low" } }],
    ["claude-sonnet-5-5", { reasoning: "off" }, { thinking: { type: "between_tools" } }],
    ["claude-opus-5", { reasoning: "off", maxTokens: 320 }, { thinking: { type: "disabled" }, max_tokens: 320 }],
    ["claude-opus-4-8", { reasoningEffort: "medium" }, { output_config: { effort: "medium" } }],
    ["claude-opus-4-8", { reasoning: 2048 }, { thinking: { type: "adaptive", display: "summarized" } }],
    ["claude-haiku-4-5", { reasoning: 2048, maxTokens: 1000 }, { thinking: { type: "enabled", budget_tokens: 2048 }, max_tokens: 3072 }],
    ["claude-sonnet-4-5-20250929", {}, { max_tokens: 8192 }],
  ])("shapes %s for %j", async (model, params, expected) => {
    const { provider, body } = gateway();
    await collect(provider(model).chat(user, undefined, { params }));
    expect(body()).toMatchObject(expected);
  });

  it.each([
    ["claude-opus-5-5", { reasoning: "off" as const }, "thinking"],
    ["claude-opus-4-8", {}, "thinking"],
    ["claude-haiku-4-5", { reasoningEffort: "low" as const }, "output_config"],
  ])("omits what %s would reject", async (model, params, field) => {
    const { provider, body } = gateway();
    await collect(provider(model).chat(user, undefined, { params }));
    expect(body()).not.toHaveProperty(field);
  });

  it("uses structured outputs instead of forcing a tool, and keeps the real tools", async () => {
    const { provider, body } = gateway();
    const responseSchema = { type: "object", properties: { a: { type: "string", minLength: 1 } }, required: ["a"] };
    await collect(provider("claude-opus-5-5").chat(user, [{ name: "search", description: "d", parameters: { type: "object" } }], { params: { responseSchema } }));
    expect(body().tool_choice).toBeUndefined();
    expect(body().tools.map((tool: { name: string }) => tool.name)).toEqual(["search"]);
    expect(body().output_config.format).toMatchObject({ type: "json_schema", schema: { additionalProperties: false } });
    expect(body().output_config.format.schema.properties.a).not.toHaveProperty("minLength");
  });

  it("asks for JSON in the system prompt, which has no json_object mode", async () => {
    const { provider, body } = gateway();
    await collect(provider("claude-opus-5-5").chat([{ role: "system", content: "Be brief." }, ...user], undefined, { params: { responseFormat: "json_object" } }));
    expect(body().system[0].text).toMatch(/^Be brief\.\n\n.*single JSON object/s);
  });

  it("does not resend a failed call", async () => {
    const { fetcher, provider } = gateway(() => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } }), {
      status: 429, headers: { "content-type": "application/json" },
    }));
    const ended: unknown[] = [];
    await expect(collect(provider("claude-opus-5-5").chat(user, undefined, { onAttemptEnd: (error) => ended.push(error) }))).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ended).toHaveLength(1);
  });
});

describe("AnthropicProvider conversation", () => {
  const model = "claude-opus-5-5";
  const tools = [{ name: "search", description: "d", parameters: { type: "object" } }];

  async function turn(provider: AnthropicProvider, history: Message[]): Promise<Message[]> {
    const done = (await collect(provider.chat(history, tools))).find((c) => c.type === "done");
    return [...history, {
      role: "assistant", content: "", responseState: done?.responseState,
      toolCalls: [{ id: "toolu_1", name: "search", arguments: { q: "a" } }],
    }, { role: "tool", toolCallId: "toolu_1", content: "result" }];
  }

  it("replays thinking blocks unchanged on a tool continuation", async () => {
    const { provider, body } = gateway(() => sse(thinkingToolReply));
    const history = await turn(provider(model), user);
    await collect(provider(model).chat(history, tools));
    expect(body(1).messages[1].content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig-1" },
      { type: "tool_use", id: "toolu_1", name: "search", input: { q: "a" } },
    ]);
  });

  it("drops thinking up to a rewritten turn but keeps it after", async () => {
    const { provider, body } = gateway(() => sse(thinkingToolReply));
    const llm = provider(model);
    const afterFirst = await turn(llm, user);
    const afterSecond = await turn(llm, afterFirst);
    const compressed: Message[] = [{ ...afterSecond[0], content: "summary of earlier turns" }, ...afterSecond.slice(1)];
    await collect(llm.chat(compressed, tools));
    const blockTypes = (index: number) => body(2).messages[index].content.map((block: { type: string }) => block.type);
    expect(blockTypes(1)).toEqual(["tool_use"]);
    expect(blockTypes(3)).toEqual(["tool_use"]);

    const rebuiltSystem = await turn(llm, [{ role: "system", content: "new rules" }, ...afterFirst.slice(0, 1)]);
    await collect(llm.chat([{ role: "system", content: "other rules" }, ...rebuiltSystem.slice(1)], tools));
    expect(body(4).messages[1].content.map((block: { type: string }) => block.type)).toEqual(["tool_use"]);
  });

  it("does not replay blocks written by another model", () => {
    const message: Message = {
      role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: {} }],
      responseState: { model: "claude-sonnet-5-5", prefix: "p", items: [{ type: "thinking", thinking: "", signature: "s" }] },
    };
    const { messages } = toAnthropicConversation([message], model, "seed");
    expect(messages[0].content).toEqual([{ type: "tool_use", id: "c", name: "t", input: {} }]);
  });

  it("merges parallel tool results into one turn and normalizes foreign tool ids", () => {
    const { messages } = toAnthropicConversation([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "functions.search:0", name: "search", arguments: {} }, { id: "call_2", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "functions.search:0", content: "one" },
      { role: "tool", toolCallId: "call_2", content: [{ type: "text", text: "two" }] },
      { role: "user", content: "next" },
    ], model, "seed");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[1].content).toMatchObject([{ id: "functions_search_0" }, { id: "call_2" }]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "functions_search_0", content: "one" },
      { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "two" }] },
    ]);
  });

  it("skips an assistant turn with nothing to send", () => {
    const { messages } = toAnthropicConversation([{ role: "user", content: "a" }, { role: "assistant", content: "" }, { role: "user", content: "b" }], model, "seed");
    expect(messages.map((m) => m.content)).toEqual(["a", "b"]);
  });
});

describe("withCacheControl", () => {
  it("wraps a plain string message into a single cache-breakpointed text block", async () => {
    const { withCacheControl } = await import("./anthropic.js");
    const out = withCacheControl({ role: "user", content: "hello" });
    expect(out.content).toEqual([
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("adds cache_control only to the last block of a multi-block message", async () => {
    const { withCacheControl } = await import("./anthropic.js");
    const out = withCacheControl({
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(out.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("leaves an empty-string message unchanged", async () => {
    const { withCacheControl } = await import("./anthropic.js");
    const msg = { role: "user" as const, content: "" };
    expect(withCacheControl(msg)).toBe(msg);
  });
});

describe("Anthropic stream integrity", () => {
  it("preserves max_tokens instead of reporting a complete answer", async () => {
    const out = await collect(mapAnthropicStream(eventStream([
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ])));
    expect(out.find(c => c.type === "done")?.finishReason).toBe("length");
  });
  it("reports a refusal as filtered and runs none of its tool calls", async () => {
    const out = await collect(mapAnthropicStream(eventStream([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "write" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ])));
    expect(out.some(c => c.type === "tool_call")).toBe(false);
    expect(out.find(c => c.type === "done")?.finishReason).toBe("content_filter");
  });
  it("keeps paid usage and hides the upstream body when a stream breaks", async () => {
    const events = (async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 7 } } };
      throw new Error("upstream body with secrets");
    })();
    const error = await collect(mapAnthropicStream(events as AsyncIterable<never>)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMResponseError);
    expect((error as LLMResponseError).message).not.toContain("secrets");
    expect((error as LLMResponseError).usage?.promptTokens).toBe(7);
  });
  it("rejects incomplete tool JSON without adding invalid calls to history", async () => {
    await expect(collect(mapAnthropicStream(eventStream([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "write" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"v":' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ])))).rejects.toThrow(/malformed tool_call/);
  });
  it("rejects a stream with no message_stop", async () => {
    await expect(collect(mapAnthropicStream(eventStream([])))).rejects.toThrow(/completion/);
  });
});
