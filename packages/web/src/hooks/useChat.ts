import { useState, useCallback, useRef } from "react";
import { api, type UploadedAttachment } from "../api/client.js";

export interface DisplayMessage {
  id: string;
  dbId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResult?: { name: string; output: string; isError: boolean };
  isStreaming?: boolean;
  rating?: number | null;
  attachments?: UploadedAttachment[];
}

export function useChat(
  conversationId: string | null,
  onStreamEnd?: () => void,
  conversationIdRef?: React.RefObject<string | null>,
  onTitle?: (conversationId: string, title: string) => void
) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const onStreamEndRef = useRef(onStreamEnd);
  onStreamEndRef.current = onStreamEnd;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  // Allow caller to inject a ref so send() reads the latest id synchronously.
  const cidRef = conversationIdRef ?? { current: conversationId };

  const loadMessages = useCallback(async (convId: string) => {
    const data = await api.getConversation(convId);
    const display: DisplayMessage[] = data.messages.map((m) => {
      const role = m.role as DisplayMessage["role"];
      const toolName = (m as { tool_name?: string | null }).tool_name;
      const meta = m.metadata;
      const parsedMeta = typeof meta === "string" ? JSON.parse(meta) : meta;
      return {
        id: m.id,
        dbId: m.id,
        role,
        content: m.content,
        attachments:
          role === "user"
            ? (parsedMeta?.attachments as UploadedAttachment[] | undefined)
            : undefined,
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
    (content: string, files: File[] = [], preUploaded?: UploadedAttachment[]) => {
      const cid = cidRef.current;
      if (
        !cid ||
        (!content.trim() && files.length === 0 && !preUploaded?.length) ||
        isStreaming
      )
        return;

      setIsStreaming(true);

      // One controller for the whole turn so Stop can abort an in-flight upload
      // (set BEFORE uploads start), not just the SSE stream.
      const controller = new AbortController();
      abortRef.current = controller;

      (async () => {
        // Upload any attached files first, then send the message with their refs.
        // When regenerating we already have the uploaded refs — reuse them.
        let uploaded: UploadedAttachment[] = preUploaded ?? [];
        if (!preUploaded) {
          try {
            uploaded = await Promise.all(
              files.map((f) => api.uploadFile(f, controller.signal))
            );
          } catch (e) {
            setIsStreaming(false);
            if (controller.signal.aborted) return; // user pressed Stop — silent
            window.alert(
              `文件上传失败：${e instanceof Error ? e.message : String(e)}`
            );
            return;
          }
        }

        const userMsgId = `user-${Date.now()}`;
        const userMsg: DisplayMessage = {
          id: userMsgId,
          role: "user",
          content,
          attachments: uploaded,
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

        api.sendMessage(cid, content, async (event) => {
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
          // The "executing tool" state stays visible until tool_result arrives,
          // so no artificial delay is needed. Blocking here would stall the
          // awaited SSE read loop and add real latency per tool call.
        }

        if (event.type === "tool_result") {
          // The assistant message that issued this tool call is now done —
          // finalize it so its (empty) bubble stops showing the typing dots.
          const finishedAssistantId = assistantMsg.id;
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
          setMessages((prev) => [
            ...prev.map((m) =>
              m.id === finishedAssistantId ? { ...m, isStreaming: false } : m
            ),
            resultMsg,
          ]);

          // Reset for next LLM iteration (new assistant message)
          assistantMsg = {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: "",
            isStreaming: true,
          };
          pendingToolCalls = [];
        }

        if (event.type === "title" && event.title) {
          // Live sidebar title update — no refresh needed.
          const tcid = cidRef.current;
          if (tcid) onTitleRef.current?.(tcid, event.title);
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

          if (event.type === "stream_end" && cid) {
            loadMessages(cid);
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
      }, uploaded, controller);
      })();
    },
    [conversationId, isStreaming, loadMessages]
  );

  const regenerate = useCallback(async () => {
    if (isStreaming || !conversationId) return;

    const reversed = [...messages].reverse();
    const lastUserMsg = reversed.find((m) => m.role === "user" && m.dbId);
    if (!lastUserMsg?.dbId) return;

    const lastUserContent = lastUserMsg.content;
    // Preserve the original message's attachments so regenerating a message
    // that carried a file doesn't silently drop the document/image content.
    const lastUserAttachments = lastUserMsg.attachments;

    try {
      await api.regenerate(conversationId, lastUserMsg.dbId);
    } catch (error) {
      console.warn("Regenerate cleanup failed:", error);
    }

    const lastUserIdx = messages.lastIndexOf(lastUserMsg);
    setMessages((prev) => prev.slice(0, lastUserIdx));

    streamMessage(lastUserContent, [], lastUserAttachments);
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
