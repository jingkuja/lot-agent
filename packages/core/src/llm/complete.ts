import type { ChatOptions, LLMProvider, Message } from "../types/index.js";

/** Drains a chat() stream and returns the concatenated text content. */
export async function complete(
  llm: LLMProvider,
  messages: Message[],
  opts?: ChatOptions
): Promise<string> {
  let text = "";
  for await (const chunk of llm.chat(messages, undefined, opts)) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
  }
  return text;
}
