import type { ChatChunk, ChatOptions, LLMProvider, LLMTool, Message } from "@lot-agent/core";

export type LLMUsage = NonNullable<ChatChunk["usage"]>;

/**
 * Wrap an LLMProvider so every chat() call reports its final usage to
 * `onUsage`. Chunks pass through untouched. Used to meter LLM calls that
 * bypass the agent loop's own accounting (e.g. the context-compression
 * `complete()` path, which drains the stream and would otherwise drop usage).
 */
export function meterLLM(llm: LLMProvider, onUsage: (usage: LLMUsage) => void): LLMProvider {
  return {
    async *chat(
      messages: Message[],
      tools?: LLMTool[],
      opts?: ChatOptions
    ): AsyncIterable<ChatChunk> {
      for await (const chunk of llm.chat(messages, tools, opts)) {
        if (chunk.type === "done" && chunk.usage) onUsage(chunk.usage);
        yield chunk;
      }
    },
  };
}
