import { describe, it, expect } from "vitest";
import { complete } from "./complete.js";
import type { ChatChunk, LLMProvider, Message } from "../types/index.js";

function fakeLLM(chunks: ChatChunk[]): LLMProvider {
  return {
    async *chat(): AsyncIterable<ChatChunk> {
      for (const c of chunks) yield c;
    },
  };
}

describe("complete", () => {
  it("concatenates all text chunks into one string", async () => {
    const llm = fakeLLM([
      { type: "text", content: "Hello, " },
      { type: "text", content: "world!" },
      { type: "done", finishReason: "stop" },
    ]);
    const result = await complete(llm, [{ role: "user", content: "hi" }] as Message[]);
    expect(result).toBe("Hello, world!");
  });

  it("ignores non-text chunks (e.g. thinking, tool_call)", async () => {
    const llm = fakeLLM([
      { type: "thinking", content: "pondering" },
      { type: "text", content: "answer" },
      { type: "done", finishReason: "stop" },
    ]);
    const result = await complete(llm, [{ role: "user", content: "hi" }] as Message[]);
    expect(result).toBe("answer");
  });

  it("returns an empty string when the stream has no text chunks", async () => {
    const llm = fakeLLM([{ type: "done", finishReason: "stop" }]);
    const result = await complete(llm, [{ role: "user", content: "hi" }] as Message[]);
    expect(result).toBe("");
  });
});
