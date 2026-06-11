import { useState, useCallback, useRef } from "react";
import { api } from "../api/client.js";

export interface DisplayMessage {
  id: string;
  dbId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResult?: { name: string; output: string; isError: boolean };
  isStreaming?: boolean;
  rating?: number | null;
}

export function useChat(
  conversationId: string | null,
  onStreamEnd?: () => void
) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const onStreamEndRef = useRef(onStreamEnd);
  onStreamEndRef.current = onStreamEnd;

  const loadMessages = useCallback(async (convId: string) => {
    const data = await api.getConversation(convId);
    const display: DisplayMessage[] = data.messages.map((m) => {
      const role = m.role as DisplayMessage["role"];
      const toolName = (m as { tool_name?: string | null }).tool_name;
      return {
        id: m.id,
        dbId: m.id,
        role,
        content: m.content,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        toolResult:
          role === "tool"
            ? { name: toolName ?? "tool", output: m.content, isError: false }
            : undefined,
        rating: m.rating ?? null,
      };
    });
    setMessages(display);
  }, []);

  const streamMessage = useCallback(
    (content: string) => {
      if (!conversationId || !content.trim() || isStreaming) return;

      const userMsgId = `user-${Date.now()}`;
      const userMsg: DisplayMessage = {
        id: userMsgId,
        role: "user",
        content,
      };
      setMessages((prev) => [...prev, userMsg]);

      let assistantMsg: DisplayMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        isStreaming: true,
      };

      // Accumulate tool calls for the current assistant message
      let pendingToolCalls: { name: string; input: unknown }[] = [];

      setIsStreaming(true);

      abortRef.current = api.sendMessage(conversationId, content, (event) => {
        if (event.type === "text" && event.content) {
          assistantMsg = {
            ...assistantMsg,
            content: assistantMsg.content + event.content,
          };
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== assistantMsg.id);
            return [...filtered, assistantMsg];
          });
        }

        if (event.type === "tool_call") {
          // Accumulate tool calls on the assistant message
          pendingToolCalls.push({
            name: event.name ?? "",
            input: event.input,
          });
          assistantMsg = {
            ...assistantMsg,
            toolCalls: [...pendingToolCalls],
          };
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== assistantMsg.id);
            return [...filtered, assistantMsg];
          });
        }

        if (event.type === "tool_result") {
          // Show tool result as a separate collapsible card
          const resultMsg: DisplayMessage = {
            id: `tool-result-${Date.now()}-${event.name}`,
            role: "tool",
            content: "",
            toolResult: {
              name: event.name ?? "",
              output: event.output ?? "",
              isError: event.isError ?? false,
            },
          };
          setMessages((prev) => [...prev, resultMsg]);

          // Reset for next LLM iteration (new assistant message)
          assistantMsg = {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: "",
            isStreaming: true,
          };
          pendingToolCalls = [];
        }

        if (event.type === "done" || event.type === "stream_end") {
          assistantMsg = { ...assistantMsg, isStreaming: false };
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== assistantMsg.id);
            // Only add if it has content or tool calls
            if (assistantMsg.content || assistantMsg.toolCalls?.length) {
              return [...filtered, assistantMsg];
            }
            return filtered;
          });
          setIsStreaming(false);

          if (event.type === "stream_end" && conversationId) {
            loadMessages(conversationId);
            onStreamEndRef.current?.();
          }
        }

        if (event.type === "error") {
          assistantMsg = {
            ...assistantMsg,
            content: assistantMsg.content + `\n\n[Error: ${event.message}]`,
            isStreaming: false,
          };
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== assistantMsg.id);
            return [...filtered, assistantMsg];
          });
          setIsStreaming(false);
        }
      });
    },
    [conversationId, isStreaming, loadMessages]
  );

  const regenerate = useCallback(async () => {
    if (isStreaming || !conversationId) return;

    const reversed = [...messages].reverse();
    const lastUserMsg = reversed.find((m) => m.role === "user" && m.dbId);
    if (!lastUserMsg?.dbId) return;

    const lastUserContent = lastUserMsg.content;

    try {
      await api.regenerate(conversationId, lastUserMsg.dbId);
    } catch (error) {
      console.warn("Regenerate cleanup failed:", error);
    }

    const lastUserIdx = messages.lastIndexOf(lastUserMsg);
    setMessages((prev) => prev.slice(0, lastUserIdx));

    streamMessage(lastUserContent);
  }, [messages, isStreaming, conversationId, streamMessage]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    send: streamMessage,
    stop,
    isStreaming,
    loadMessages,
    clear,
    regenerate,
  };
}
