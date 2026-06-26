import type { MemoryTurn } from "@lot-agent/core";

/**
 * From an ordered message list, take the last non-empty assistant reply and
 * the nearest preceding user message — the turn the extractor analyzes.
 */
export function lastTurn(
  messages: Array<{ role: string; content: string }>
): MemoryTurn | null {
  let assistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content.trim()) {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx === -1) return null;

  let userMessage = "";
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userMessage = messages[i].content;
      break;
    }
  }
  return { userMessage, assistantText: messages[assistantIdx].content };
}
