import { useState, useCallback, useRef } from "react";
import { api, type UploadedAttachment } from "../api/client.js";

export interface GenerationView {
  mediaType: "image" | "video";
  status: "generating" | "completed" | "failed";
  progress?: number;
  /** Whether the provider reports intermediate progress. When false (e.g. the
   * synchronous chat-completions image provider) the UI shows a plain "生成中……"
   * with no percentage. */
  supportsProgress?: boolean;
  assets?: { url: string; mime: string; durationSec?: number }[];
  error?: string;
  taskId?: string;
}

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
  generation?: GenerationView;
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
  const genPollRef = useRef<{ cancelled: boolean } | null>(null);
  const onStreamEndRef = useRef(onStreamEnd);
  onStreamEndRef.current = onStreamEnd;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  // Allow caller to inject a ref so send() reads the latest id synchronously.
  const cidRef = conversationIdRef ?? { current: conversationId };

  // Poll a generation task until it terminates, patching the message by id with
  // live progress, then the final assets/failure. Shared by a fresh send and by
  // resuming an in-flight generation after a conversation (re)load. The caller
  // owns the cancellation `token` (stored in genPollRef) so switching away stops it.
  const pollGeneration = useCallback(
    (taskId: string, messageId: string, mediaType: "image" | "video", token: { cancelled: boolean }) => {
      let failures = 0;
      const poll = async () => {
        if (token.cancelled) return;
        try {
          const t = await api.getTask(taskId);
          if (token.cancelled) return;
          // Guard against a malformed/unexpected response body (wrong shape,
          // an error object served with 200, a proxy HTML page, etc.). Without
          // this, an unknown `status` falls through to the progress branch and
          // the loop polls forever instead of ever terminating. Route it through
          // the failure budget so persistent bad responses fail the generation.
          const known = ["pending", "running", "succeeded", "failed"];
          if (!t || !known.includes(t.status)) {
            throw new Error("任务状态返回格式异常");
          }
          failures = 0;
          if (t.status === "succeeded" || t.status === "failed") {
            const out = t.output as { assets?: { url: string; mime: string; durationSec?: number }[] } | undefined;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? { ...m, generation: { mediaType, status: t.status === "succeeded" ? "completed" : "failed", progress: 100, assets: out?.assets, error: t.error, taskId } }
                  : m
              )
            );
            if (genPollRef.current === token) genPollRef.current = null;
            setIsStreaming(false);
            onStreamEndRef.current?.();
            return;
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId && m.generation
                ? { ...m, generation: { ...m.generation, status: "generating", progress: t.progress } }
                : m
            )
          );
        } catch {
          failures += 1;
          if (failures >= 15) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? { ...m, generation: { mediaType, status: "failed", error: "生成状态获取失败", taskId } }
                  : m
              )
            );
            if (genPollRef.current === token) genPollRef.current = null;
            setIsStreaming(false);
            onStreamEndRef.current?.();
            return;
          }
        }
        if (!token.cancelled) setTimeout(poll, 1000);
      };
      poll();
    },
    []
  );

  const loadMessages = useCallback(async (convId: string) => {
    const data = await api.getConversation(convId);
    const display: DisplayMessage[] = data.messages.map((m) => {
      const role = m.role as DisplayMessage["role"];
      const toolName = (m as { tool_name?: string | null }).tool_name;
      const meta = m.metadata;
      const parsedMeta = typeof meta === "string" ? JSON.parse(meta) : meta;
      const gen =
        role === "assistant" && parsedMeta?.kind === "generation"
          ? {
              mediaType: parsedMeta.mediaType as "image" | "video",
              status: (parsedMeta.status ?? "generating") as GenerationView["status"],
              supportsProgress: parsedMeta.supportsProgress as boolean | undefined,
              assets: parsedMeta.assets,
              error: parsedMeta.error,
              taskId: parsedMeta.taskId as string | undefined,
            }
          : undefined;
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
        generation: gen,
      };
    });
    setMessages(display);

    // Resume polling for any generation still marked "generating" (e.g. the
    // user reloaded or reopened the conversation before it finished). The
    // message carries its taskId, so we re-query the task to pick up current
    // progress / completion. At most one is expected in flight; poll the latest.
    const pending = display.filter(
      (m) => m.generation?.status === "generating" && m.generation.taskId
    );
    const last = pending[pending.length - 1];
    if (last?.generation?.taskId) {
      if (genPollRef.current) genPollRef.current.cancelled = true;
      const token = { cancelled: false };
      genPollRef.current = token;
      setIsStreaming(true);
      pollGeneration(last.generation.taskId, last.id, last.generation.mediaType, token);
    }
  }, [pollGeneration]);

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

  const generateMedia = useCallback(
    (prompt: string, mediaType: "image" | "video", settings?: unknown, files: File[] = []) => {
      const cid = cidRef.current;
      if (!cid || !prompt.trim() || isStreaming) return;
      setIsStreaming(true);

      if (genPollRef.current) genPollRef.current.cancelled = true;
      const token = { cancelled: false };
      genPollRef.current = token;

      // Optimistically render the user message + a "生成中" bubble immediately —
      // before the reference-image upload and create request resolve — so the
      // user sees "图片/视频生成中" right away instead of a stuck input box.
      // The placeholders are reconciled with server ids once /generations returns
      // (or flipped to "failed" if the request errors).
      const tempUserId = `user-${Date.now()}`;
      const tempGenId = `assistant-${Date.now()}`;
      const userMsg: DisplayMessage = { id: tempUserId, role: "user", content: prompt };
      const genMsg: DisplayMessage = {
        id: tempGenId,
        role: "assistant",
        content: "",
        generation: { mediaType, status: "generating", progress: 0 },
      };
      setMessages((prev) => [...prev, userMsg, genMsg]);

      (async () => {
        try {
          const imgs = files.filter((f) => f.type.startsWith("image/"));
          const uploaded = imgs.length ? await Promise.all(imgs.map((f) => api.uploadFile(f))) : [];
          const media = uploaded.map((u) => ({ type: "reference_image" as const, url: u.url }));

          const res = await api.generate(cid, { prompt, mediaType, settings, media: media.length ? media : undefined });
          if (token.cancelled) return;
          // Reconcile the optimistic placeholders with the server-assigned ids
          // + vendor taskId, keeping the bubble in its "generating" state.
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === tempUserId) return { ...m, id: res.userMessage.id, dbId: res.userMessage.id };
              if (m.id === tempGenId)
                return {
                  ...m,
                  id: res.assistantMessage.id,
                  dbId: res.assistantMessage.id,
                  generation: { mediaType, status: "generating", progress: 0, supportsProgress: res.assistantMessage.metadata?.supportsProgress, taskId: res.taskId },
                };
              return m;
            })
          );
          if (res.title) onTitleRef.current?.(cid, res.title);
          pollGeneration(res.taskId, res.assistantMessage.id, mediaType, token);
        } catch (e) {
          if (genPollRef.current === token) genPollRef.current = null;
          setIsStreaming(false);
          // The create request itself failed (non-2xx / network). Flip the
          // optimistic bubble to "failed" so the attempt + error stay visible.
          const msg = e instanceof Error ? e.message : String(e);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === tempGenId
                ? { ...m, generation: { mediaType, status: "failed", error: `生成请求失败：${msg}` } }
                : m
            )
          );
        }
      })();
    },
    [isStreaming, pollGeneration]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (genPollRef.current) { genPollRef.current.cancelled = true; genPollRef.current = null; }
    setIsStreaming(false);
  }, []);

  const clear = useCallback(() => {
    // Cancel any in-flight generation poll and drop the streaming lock so a
    // resumed poll in the next conversation doesn't leave the input disabled.
    if (genPollRef.current) { genPollRef.current.cancelled = true; genPollRef.current = null; }
    setIsStreaming(false);
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
    generateMedia,
  };
}
