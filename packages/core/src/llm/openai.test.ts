import { describe, it, expect, vi } from "vitest";
import { mapOpenAIStream } from "./openai.js";
import type { ChatChunk } from "../types/index.js";

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function chunkStream(chunks: unknown[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe("mapOpenAIStream", () => {
  it("waits for a trailing usage-only chunk (empty choices) before emitting done", async () => {
    const stream = chunkStream([
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    expect(out[0]).toEqual({ type: "text", content: "hi" });
    const done = out.find((c) => c.type === "done");
    expect(done?.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("emits done with usage immediately when usage arrives on the finish_reason chunk", async () => {
    const stream = chunkStream([
      {
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    const done = out.find((c) => c.type === "done");
    expect(done?.usage).toEqual({ promptTokens: 5, completionTokens: 1 });
  });

  it("emits done with no usage when the vendor never sends one", async () => {
    const stream = chunkStream([
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    const done = out.find((c) => c.type === "done");
    expect(done).toBeDefined();
    expect(done?.usage).toBeUndefined();
  });

  it("maps DeepSeek reasoning_content to a thinking chunk", async () => {
    const stream = chunkStream([
      { choices: [{ index: 0, delta: { reasoning_content: "let me think..." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    expect(out[0]).toEqual({ type: "thinking", content: "let me think..." });
  });

  it("accumulates tool call arguments by index across chunks", async () => {
    const stream = chunkStream([
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    const toolCall = out.find((c) => c.type === "tool_call");
    expect(toolCall?.toolCall).toEqual({ id: "call_1", name: "read_file", arguments: { path: "a.txt" } });
  });
});

vi.mock("openai", () => {
  class FakeAPIError extends Error {}
  return {
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };
      constructor(_config: unknown) {}
    },
    RateLimitError: FakeAPIError,
    InternalServerError: FakeAPIError,
    APIConnectionError: FakeAPIError,
    APIConnectionTimeoutError: FakeAPIError,
  };
});

describe("OpenAIProvider.chat retry", () => {
  it("retries a RateLimitError raised before any chunk and succeeds on the next attempt", async () => {
    const { OpenAIProvider } = await import("./openai.js");
    const { RateLimitError } = (await import("openai")) as unknown as {
      RateLimitError: new (msg?: string) => Error;
    };
    const provider = new OpenAIProvider({ apiKey: "x", model: "test-model" });
    const create = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create;

    let call = 0;
    create.mockImplementation(async () => {
      call++;
      if (call === 1) throw new RateLimitError("rate limited");
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
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
