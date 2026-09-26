import { LLMIncompleteError } from "./errors.js";
import type { ChatOptions, LLMProvider, Message } from "../types/index.js";

/** Drains a chat() stream and returns the concatenated text content. */
export async function complete(
  llm: LLMProvider,
  messages: Message[],
  opts?: ChatOptions
): Promise<string> {
  let text = "";
  let completed = false;
  for await (const chunk of llm.chat(messages, undefined, opts)) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
    if (chunk.type === "done") {
      completed = true;
      if (chunk.finishReason && !["stop", "end_turn", "stop_sequence", "tool_use"].includes(chunk.finishReason)) {
        throw new LLMIncompleteError(chunk.finishReason, text);
      }
    }
  }
  if (!completed) throw new Error("LLM stream ended before completion");
  return text;
}
