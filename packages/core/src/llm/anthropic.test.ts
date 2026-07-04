import { describe, it, expect, vi } from "vitest";
import { mapAnthropicStream } from "./anthropic.js";
import type { ChatChunk } from "../types/index.js";

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

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAPIError extends Error {}
  return {
    default: class FakeAnthropic {
      messages = { stream: vi.fn() };
      constructor(_config: unknown) {}
    },
    RateLimitError: FakeAPIError,
    InternalServerError: FakeAPIError,
    APIConnectionError: FakeAPIError,
    APIConnectionTimeoutError: FakeAPIError,
  };
});

describe("AnthropicProvider.chat retry", () => {
  it("retries a RateLimitError raised before any chunk and succeeds on the next attempt", async () => {
    const { AnthropicProvider } = await import("./anthropic.js");
    const { RateLimitError } = (await import("@anthropic-ai/sdk")) as unknown as {
      RateLimitError: new (msg?: string) => Error;
    };
    const provider = new AnthropicProvider({ apiKey: "x", model: "test-model" });
    const streamFn = (provider as unknown as { client: { messages: { stream: ReturnType<typeof vi.fn> } } })
      .client.messages.stream;

    let call = 0;
    streamFn.mockImplementation(() => {
      call++;
      if (call === 1) throw new RateLimitError("rate limited");
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } },
          };
          yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "message_delta", delta: {}, usage: { output_tokens: 1 } };
          yield { type: "message_stop" };
        },
      };
    });

    const out: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) out.push(chunk.content);
    }
    expect(call).toBe(2);
    expect(out).toEqual(["ok"]);
  });
});

describe("AnthropicProvider.chat reasoning", () => {
  function okStream() {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } } };
        yield { type: "message_delta", delta: {}, usage: { output_tokens: 1 } };
        yield { type: "message_stop" };
      },
    };
  }

  async function drain(it: AsyncIterable<unknown>) {
    for await (const _ of it) { /* consume */ }
  }

  it("enables extended thinking and drops temperature/top_p when reasoning is a positive budget", async () => {
    const { AnthropicProvider } = await import("./anthropic.js");
    const provider = new AnthropicProvider({ apiKey: "x", model: "test-model" });
    const streamFn = (provider as unknown as { client: { messages: { stream: ReturnType<typeof vi.fn> } } })
      .client.messages.stream;
    streamFn.mockImplementation(() => okStream());

    await drain(
      provider.chat([{ role: "user", content: "hi" }], undefined, {
        params: { reasoning: 2048, temperature: 0.7, topP: 0.9, maxTokens: 1000 },
      })
    );

    const body = streamFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    // Anthropic rejects temperature/top_p alongside extended thinking.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    // max_tokens must exceed the thinking budget.
    expect(body.max_tokens as number).toBeGreaterThan(2048);
  });

  it("omits thinking and forwards temperature/top_p when reasoning is off", async () => {
    const { AnthropicProvider } = await import("./anthropic.js");
    const provider = new AnthropicProvider({ apiKey: "x", model: "test-model" });
    const streamFn = (provider as unknown as { client: { messages: { stream: ReturnType<typeof vi.fn> } } })
      .client.messages.stream;
    streamFn.mockImplementation(() => okStream());

    await drain(
      provider.chat([{ role: "user", content: "hi" }], undefined, {
        params: { reasoning: "off", temperature: 0.7, topP: 0.9 },
      })
    );

    const body = streamFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
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
