import type { AgentEvent } from "@lot-agent/core";

/**
 * Map an AgentEvent to the JSON payload sent over SSE.
 * Pure + total over the union — every variant is handled explicitly.
 * Field names are identical to the raw event so the frontend contract is unchanged.
 */
export function agentEventToSse(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "text":
      return { type: "text", content: event.content };
    case "tool_call":
      return { type: "tool_call", id: event.id, name: event.name, input: event.input };
    case "tool_result":
      return {
        type: "tool_result",
        name: event.name,
        output: event.output,
        isError: event.isError,
      };
    case "done":
      return {
        type: "done",
        iterations: event.iterations,
        totalTokens: event.totalTokens,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    case "error":
      return { type: "error", message: event.message };
    case "artifact":
      return {
        type: "artifact",
        assetId: event.assetId,
        url: event.url,
        mediaType: event.mediaType,
      };
  }
}
