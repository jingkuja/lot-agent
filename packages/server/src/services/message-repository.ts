import { randomUUID } from "node:crypto";
import type { Message, ContentPart } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import type { AttachmentRef } from "./attachment-extractor.js";

/**
 * Handles all message/tool_call DB persistence during a chat turn.
 * Every method preserves the exact write order and row content from the
 * original streamAgentResponse implementation.
 */
export class MessageRepository {
  constructor(private readonly db: DB) {}

  /** Insert the user message and return its generated id. */
  async saveUserMessage(
    conversationId: string,
    userMessage: string,
    attachments?: AttachmentRef[]
  ): Promise<string> {
    const userMsgId = randomUUID();
    await this.db.addMessage(userMsgId, conversationId, "user", userMessage, {
      metadata: attachments?.length ? { attachments } : {},
    });
    return userMsgId;
  }

  /**
   * Load all messages for the conversation, excluding the just-saved user message,
   * and drop orphan tool messages whose tool_call_id has no matching assistant tool_call.
   * Returns history as Message[] (role/content/toolCallId).
   */
  async loadHistory(
    conversationId: string,
    excludeMessageId: string,
    materialize?: (atts: AttachmentRef[]) => Promise<ContentPart[]>
  ): Promise<Message[]> {
    const stored = await this.db.getMessages(conversationId);
    const filtered = stored.filter(
      (m) => m.role !== "user" || m.id !== excludeMessageId
    );

    // Tool calls live in a side table (message_tool_calls), keyed by message id —
    // NOT on the messages row. Load them so an assistant turn that issued tool
    // calls is reconstructed WITH its `toolCalls`, and the paired tool result is
    // kept (not dropped as an orphan). Without this, an endsTurn tool round
    // (e.g. propose_outline → user confirms next request) loses its tool call and
    // arguments entirely, so the model can't see what it already did and repeats.
    const toolCallsByMessage = await this.db.getToolCallsForConversation(conversationId);
    const validToolCallIds = new Set<string>();
    for (const calls of toolCallsByMessage.values()) {
      for (const tc of calls) validToolCallIds.add(tc.tool_call_id);
    }
    // Which tool calls actually have a result message stored. An assistant
    // tool_call with no result (e.g. the run aborted mid-execution) must NOT be
    // reconstructed — the wire format requires every tool_call to be answered by
    // a following tool message, and an unanswered one makes the API reject the
    // whole request. So we only re-attach calls whose result is present, keeping
    // assistant tool_calls and tool results strictly paired.
    const answeredToolCallIds = new Set<string>();
    for (const m of filtered) {
      if (m.role === "tool" && m.tool_call_id && validToolCallIds.has(m.tool_call_id)) {
        answeredToolCallIds.add(m.tool_call_id);
      }
    }

    // Filter out orphan tool messages (no matching assistant tool_call)
    const history: Message[] = [];
    for (const m of filtered) {
      if (m.role === "tool" && m.tool_call_id) {
        if (!validToolCallIds.has(m.tool_call_id)) continue; // orphan — skip
      }
      let content: Message["content"] = m.content;
      // Re-materialize a user message's attachments so later turns still see
      // the uploaded image/document content.
      if (m.role === "user" && materialize) {
        const meta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
        const atts = (meta?.attachments ?? []) as AttachmentRef[];
        if (atts.length) {
          const parts = await materialize(atts);
          content = [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...parts,
          ];
        }
      }
      const msg: Message = {
        role: m.role as Message["role"],
        content,
        toolCallId: m.tool_call_id ?? undefined,
      };
      if (m.role === "assistant") {
        const calls = toolCallsByMessage
          .get(m.id)
          ?.filter((tc) => answeredToolCallIds.has(tc.tool_call_id));
        if (calls?.length) {
          msg.toolCalls = calls.map((tc) => ({
            id: tc.tool_call_id,
            name: tc.tool_name,
            arguments: tc.tool_input,
          }));
        }
      }
      history.push(msg);
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
    toolCalls: { id: string; name: string; arguments: unknown }[],
    thinking?: string
  ): Promise<string> {
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content,
      { toolCallId: undefined, metadata: thinking ? { thinking } : {} }
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
    toolCalls: { id: string; name: string; arguments: unknown }[],
    thinking?: string
  ): Promise<void> {
    if (!content && toolCalls.length === 0) return;
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content,
      { metadata: thinking ? { thinking } : {} }
    );
    for (const tc of toolCalls) {
      await this.db.addToolCall(assistantMsgId, tc.id, tc.name, tc.arguments);
    }
  }
}
