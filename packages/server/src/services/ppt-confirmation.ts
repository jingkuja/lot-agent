import { randomUUID } from "node:crypto";
import type { AgentEvent, Tool, ToolContext } from "@lot-agent/core";
import type { PptDeck } from "@lot-agent/core/presentation";
import type { MessageRepository } from "./message-repository.js";

/** A confirmation is an export action, not another generative model turn. */
export async function* exportConfirmedPpt(
  deck: PptDeck,
  tool: Tool,
  repository: Pick<MessageRepository, "saveAssistantWithToolCalls" | "saveToolResult">,
  context: ToolContext & { conversationId: string },
): AsyncIterable<AgentEvent> {
  const id = randomUUID();
  context.signal?.throwIfAborted();
  await repository.saveAssistantWithToolCalls(context.conversationId, "", [{ id, name: tool.name, arguments: deck }]);
  yield { type: "tool_call", id, name: tool.name, input: deck };
  let result;
  try {
    result = await tool.execute(deck, context);
  } catch (error) {
    // Pair even failed/cancelled exports with their persisted tool call so reloads are valid.
    result = { content: context.signal?.aborted ? "PPT export cancelled." : "PPT export failed. Please retry.", isError: true };
    await repository.saveToolResult(context.conversationId, id, result.content, true);
    if (context.signal?.aborted) throw error;
    yield { type: "tool_result", toolCallId: id, name: tool.name, output: result.content, isError: true };
    yield { type: "done", iterations: 0, totalTokens: 0, cachedPromptTokens: 0, inputTokens: 0, outputTokens: 0, status: "failed" };
    return;
  }
  await repository.saveToolResult(context.conversationId, id, result.content, result.isError);
  yield { type: "tool_result", toolCallId: id, name: tool.name, output: result.content, isError: result.isError ?? false, errorKind: result.errorKind };
  yield { type: "done", iterations: 0, totalTokens: 0, cachedPromptTokens: 0, inputTokens: 0, outputTokens: 0, status: result.isError ? "failed" : "completed" };
}
