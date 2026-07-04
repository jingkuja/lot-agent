import { describe, it, expect } from "vitest";
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
    expect(done?.usage).toEqual({ promptTokens: 100, completionTokens: 8, cachedPromptTokens: 20 });
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
