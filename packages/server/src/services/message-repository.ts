import { randomUUID } from "node:crypto";
import type { Message } from "@lot-agent/core";
import type { DB } from "../db/database.js";

/**
 * Handles all message/tool_call DB persistence during a chat turn.
 * Every method preserves the exact write order and row content from the
 * original streamAgentResponse implementation.
 */
export class MessageRepository {
  constructor(private readonly db: DB) {}

  /** Insert the user message and return its generated id. */
  async saveUserMessage(conversationId: string, userMessage: string): Promise<string> {
    const userMsgId = randomUUID();
    await this.db.addMessage(userMsgId, conversationId, "user", userMessage);
    return userMsgId;
  }

  /**
   * Load all messages for the conversation, excluding the just-saved user message,
   * and drop orphan tool messages whose tool_call_id has no matching assistant tool_call.
   * Returns history as Message[] (role/content/toolCallId).
   */
  async loadHistory(conversationId: string, excludeMessageId: string): Promise<Message[]> {
    const stored = await this.db.getMessages(conversationId);
    const filtered = stored.filter(
      (m) => m.role !== "user" || m.id !== excludeMessageId
    );

    // Collect all tool_call_ids that are referenced by assistant messages
    const validToolCallIds = new Set<string>();
    for (const m of filtered) {
      if (m.role === "assistant" && m.tool_calls) {
        try {
          const calls = JSON.parse(m.tool_calls) as { id: string }[];
          for (const tc of calls) {
            if (tc.id) validToolCallIds.add(tc.id);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Filter out orphan tool messages (no matching assistant tool_call)
    const history: Message[] = [];
    for (const m of filtered) {
      if (m.role === "tool" && m.tool_call_id) {
        if (!validToolCallIds.has(m.tool_call_id)) continue; // orphan — skip
      }
      history.push({
        role: m.role as Message["role"],
        content: m.content,
        toolCallId: m.tool_call_id ?? undefined,
      });
    }
    return history;
  }

  /**
   * Insert an assistant message with its tool call records (mid-turn, when a tool_result arrives).
   * Returns the assistant message id.
   */
  async saveAssistantWithToolCalls(
    conversationId: string,
    content: string,
    toolCalls: { id: string; name: string; arguments: unknown }[]
  ): Promise<string> {
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content,
      { toolCallId: undefined }
    );
    for (const tc of toolCalls) {
      await this.db.addToolCall(assistantMsgId, tc.id, tc.name, tc.arguments);
    }
    return assistantMsgId;
  }

  /** Insert a tool result message. */
  async saveToolResult(
    conversationId: string,
    toolCallId: string | undefined,
    output: string
  ): Promise<void> {
    await this.db.addMessage(
      randomUUID(),
      conversationId,
      "tool",
      output,
      { toolCallId }
    );
  }

  /**
   * Insert the trailing assistant message (finally-block save).
   * Only writes if there is content or pending tool calls.
   */
  async saveFinalAssistant(
    conversationId: string,
    content: string,
    toolCalls: { id: string; name: string; arguments: unknown }[]
  ): Promise<void> {
    if (!content && toolCalls.length === 0) return;
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content
    );
    for (const tc of toolCalls) {
      await this.db.addToolCall(assistantMsgId, tc.id, tc.name, tc.arguments);
    }
  }
}
