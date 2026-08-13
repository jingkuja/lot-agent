import { useReducer, useCallback, useRef, useState } from "react";
import { api, type KnowledgeBaseRef, type UploadedAttachment, type PickedFile } from "../api/client.js";
import { randomId } from "../lib/uuid.js";
import { showAlert, notifyDesktop } from "../lib/notify.js";
import {
  chatReducer,
  initialChatState,
  type DisplayMessage,
  type GenerationView,
} from "./chat-reducer.js";

// The message/generation view models live with the reducer; components keep
// importing them from here.
export type { DisplayMessage, GenerationView } from "./chat-reducer.js";

export function useChat(
  conversationId: string | null,
  onStreamEnd?: () => void,
  conversationIdRef?: React.RefObject<string | null>,
  onTitle?: (conversationId: string, title: string) => void
) {
  // All view state lives in the pure reducer (chat-reducer.ts). This hook only
  // translates async events (SSE, generation polling, user actions) into
  // ChatActions and owns the IO side effects (streams, uploads, polling).
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [conversationKnowledgeBases, setConversationKnowledgeBases] = useState<KnowledgeBaseRef[]>([]);
  // One live SSE stream per conversation id. Switching away must NOT kill the
  // stream (the reply still persists server-side) — but its events may only
  // touch the view while its conversation is the one on screen, otherwise a
  // concurrent chat bleeds its reply into whatever conversation is displayed.
  const streamsRef = useRef<Map<string, AbortController>>(new Map());
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
          const known = ["pending", "running", "succeeded", "failed", "cancelled"];
          if (!t || !known.includes(t.status)) {
            throw new Error("任务状态返回格式异常");
          }
          failures = 0;
          if (t.status === "succeeded" || t.status === "failed" || t.status === "cancelled") {
            const out = t.output;
            // A 'succeeded' task can still carry downloadFailed: the vendor made
            // the media but the server-side download of it failed. That's a
            // recoverable "下载失败" state (offers re-download), not a generation
            // failure.
            const downloadFailed = t.status === "succeeded" && out?.downloadFailed === true;
            const finalStatus: GenerationView["status"] = downloadFailed
              ? "download_failed"
              : t.status === "succeeded"
                ? "completed"
                : t.status === "cancelled"
                  ? "cancelled"
                  : "failed";
            dispatch({
              type: "generation_finished",
              messageId,
              generation: {
                mediaType,
                status: finalStatus,
                progress: 100,
                assets: out?.assets,
                error: downloadFailed ? (out?.error as string | undefined) : t.error,
                taskId,
              },
            });
            // Desktop: background-completion system notification (no-op in the
            // browser, and the shell suppresses it while the window is focused).
            const mediaLabel = mediaType === "image" ? "图片" : "视频";
            if (finalStatus === "completed") {
              notifyDesktop(`${mediaLabel}生成完成`, "点击查看结果");
            } else if (finalStatus !== "cancelled") {
              notifyDesktop(
                `${mediaLabel}生成失败`,
                downloadFailed ? "媒体下载失败，可重试下载" : t.error
              );
            }
            if (genPollRef.current === token) genPollRef.current = null;
            onStreamEndRef.current?.();
            return;
          }
          dispatch({ type: "generation_progress", messageId, progress: t.progress });
        } catch {
          failures += 1;
          if (failures >= 15) {
            dispatch({
              type: "generation_finished",
              messageId,
              generation: { mediaType, status: "failed", error: "生成状态获取失败", taskId },
            });
            if (genPollRef.current === token) genPollRef.current = null;
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
    // The user may have switched again while this fetch was in flight — a
    // stale response must not overwrite the conversation now on screen.
    if (cidRef.current !== convId) return;
    const rawStoredKnowledgeBases = data.metadata?.knowledgeBases;
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
        thinking: parsedMeta?.thinking as string | undefined,
        attachments:
          role === "user"
            ? (parsedMeta?.attachments as UploadedAttachment[] | undefined)
            : undefined,
        knowledgeBases:
          role === "user"
            ? (parsedMeta?.knowledgeBases as KnowledgeBaseRef[] | undefined)
            : undefined,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        toolResult:
          role === "tool"
            ? {
                name: toolName ?? "tool",
                output: m.content,
                // Persisted by saveToolResult for failed calls; the UI needs it
                // to keep rejected interactive calls (propose_outline/ask_user)
                // from re-rendering as live confirmation cards after reload.
                isError: parsedMeta?.isError === true,
              }
            : undefined,
        rating: m.rating ?? null,
        generation: gen,
      };
    });
    const storedKnowledgeBases = Array.isArray(rawStoredKnowledgeBases)
      ? rawStoredKnowledgeBases.filter(
          (item): item is KnowledgeBaseRef =>
            !!item &&
            typeof item === "object" &&
            typeof (item as KnowledgeBaseRef).id === "string" &&
            typeof (item as KnowledgeBaseRef).name === "string"
        )
      : undefined;
    // Backward compatibility: conversations created before selection became
    // conversation metadata still carry it on their user messages. Restore
    // the latest such selection once; the next send persists it on the chat.
    const latestMessageKnowledgeBases = [...display]
      .reverse()
      .find((message) => message.role === "user" && message.knowledgeBases)?.knowledgeBases;
    setConversationKnowledgeBases(storedKnowledgeBases ?? latestMessageKnowledgeBases ?? []);
    // Re-entering a conversation whose stream is still live re-disables the
    // input; its stream events re-attach to the view on the next chunk.
    dispatch({
      type: "snapshot_loaded",
      messages: display,
      model: (data as { model?: string | null }).model ?? null,
      isStreaming: streamsRef.current.has(convId),
    });

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
      dispatch({ type: "stream_started" });
      pollGeneration(last.generation.taskId, last.id, last.generation.mediaType, token);
    }
  }, [pollGeneration]);

  const streamMessage = useCallback(
    (
      content: string,
      files: PickedFile[] = [],
      preUploaded?: UploadedAttachment[],
      modelId?: string,
      knowledgeBases: KnowledgeBaseRef[] = []
    ) => {
      const cid = cidRef.current;
      if (
        !cid ||
        (!content.trim() && files.length === 0 && !preUploaded?.length) ||
        state.isStreaming ||
        streamsRef.current.has(cid)
      )
        return;

      dispatch({ type: "stream_started" });

      // One controller for the whole turn so Stop can abort an in-flight upload
      // (set BEFORE uploads start), not just the SSE stream.
      const controller = new AbortController();
      streamsRef.current.set(cid, controller);
      // True while this stream's conversation is still the one on screen.
      // Every dispatch below is gated on it; the stream itself keeps running
      // (and persisting) even when the user switches away.
      const isCurrent = () => cidRef.current === cid;

      (async () => {
        // Upload any attached files first, then send the message with their refs.
        // When regenerating we already have the uploaded refs — reuse them.
        let uploaded: UploadedAttachment[] = preUploaded ?? [];
        if (!preUploaded) {
          try {
            uploaded = await Promise.all(
              files.map(async (f) => {
                const u = await api.uploadFile(f.file, controller.signal);
                return f.slot ? { ...u, slot: f.slot } : u;
              })
            );
          } catch (e) {
            streamsRef.current.delete(cid);
            if (isCurrent()) dispatch({ type: "stream_stopped" });
            if (controller.signal.aborted) return; // user pressed Stop — silent
            showAlert(
              `文件上传失败：${e instanceof Error ? e.message : String(e)}`
            );
            return;
          }
        }

        const userMsg: DisplayMessage = {
          id: `user-${randomId()}`,
          role: "user",
          content,
          attachments: uploaded,
          knowledgeBases,
        };
        if (isCurrent()) dispatch({ type: "user_appended", message: userMsg });

        // The accumulating assistant message for the current LLM iteration.
        // It deliberately lives here, NOT in the reducer: while this stream's
        // conversation is off-screen no action is dispatched at all, and the
        // full accumulated message re-attaches on the first event after the
        // user switches back.
        let assistantMsg: DisplayMessage = {
          id: `assistant-${randomId()}`,
          role: "assistant",
          content: "",
          isStreaming: true,
        };
        let pendingToolCalls: { name: string; input: unknown }[] = [];

        // stream_end ends the turn but the connection stays open for the tail
        // (title generation). A new send may reuse this cid meanwhile, so tail
        // handlers must not touch the map entry unless it is still ours.
        let turnEnded = false;
        const releaseStream = () => {
          if (streamsRef.current.get(cid) === controller)
            streamsRef.current.delete(cid);
        };

        api.sendMessage(cid, content, async (event) => {
        if (event.type === "thinking" && event.content) {
          assistantMsg = {
            ...assistantMsg,
            thinking: (assistantMsg.thinking ?? "") + event.content,
          };
          if (isCurrent()) dispatch({ type: "assistant_upserted", message: assistantMsg });
        }

        if (event.type === "text" && event.content) {
          assistantMsg = {
            ...assistantMsg,
            content: assistantMsg.content + event.content,
          };
          if (isCurrent()) dispatch({ type: "assistant_upserted", message: assistantMsg });
        }

        if (event.type === "tool_call") {
          pendingToolCalls.push({
            name: event.name ?? "",
            input: event.input,
          });
          assistantMsg = {
            ...assistantMsg,
            toolCalls: [...pendingToolCalls],
          };
          if (isCurrent()) dispatch({ type: "assistant_upserted", message: assistantMsg });
          // The "executing tool" state stays visible until tool_result arrives,
          // so no artificial delay is needed. Blocking here would stall the
          // awaited SSE read loop and add real latency per tool call.
        }

        if (event.type === "tool_result") {
          // The assistant message that issued this tool call is now done —
          // the reducer finalizes it and shows the result as a separate card.
          if (isCurrent())
            dispatch({
              type: "tool_result_appended",
              assistantId: assistantMsg.id,
              cardId: `tool-result-${event.toolCallId ?? randomId()}-${event.name}`,
              name: event.name ?? "",
              output: event.output ?? "",
              isError: event.isError ?? false,
            });

          // Reset for next LLM iteration (new assistant message)
          assistantMsg = {
            id: `assistant-${randomId()}`,
            role: "assistant",
            content: "",
            isStreaming: true,
          };
          pendingToolCalls = [];
        }

        if (event.type === "title" && event.title) {
          // Live sidebar title update — keyed by THIS stream's conversation,
          // not whatever conversation happens to be on screen when it lands.
          onTitleRef.current?.(cid, event.title);
        }

        if (event.type === "done" || event.type === "stream_end") {
          assistantMsg = { ...assistantMsg, isStreaming: false };
          if (isCurrent()) dispatch({ type: "turn_finalized", message: assistantMsg });

          if (event.type === "stream_end") {
            turnEnded = true;
            releaseStream();
            if (isCurrent()) loadMessages(cid);
            // Sidebar refresh runs regardless — the finished conversation's
            // title/order must update even while another one is on screen.
            onStreamEndRef.current?.();
          }
        }

        if (event.type === "error") {
          // A failure in the tail (after stream_end) only concerns the
          // best-effort title — the turn already ended cleanly on screen.
          if (turnEnded) return;
          releaseStream();
          assistantMsg = {
            ...assistantMsg,
            content: assistantMsg.content + `\n\n[Error: ${event.message}]`,
            isStreaming: false,
          };
          if (isCurrent()) dispatch({ type: "turn_finalized", message: assistantMsg });
        }
      }, uploaded, controller, modelId, knowledgeBases.map((item) => item.id));
      })();
    },
    [conversationId, state.isStreaming, loadMessages]
  );

  const regenerate = useCallback(async () => {
    if (state.isStreaming || !conversationId) return;

    const reversed = [...state.messages].reverse();
    const lastUserMsg = reversed.find((m) => m.role === "user" && m.dbId);
    if (!lastUserMsg?.dbId) return;

    const lastUserContent = lastUserMsg.content;
    // Preserve the original message's attachments so regenerating a message
    // that carried a file doesn't silently drop the document/image content.
    const lastUserAttachments = lastUserMsg.attachments;
    const lastUserKnowledgeBases = lastUserMsg.knowledgeBases;

    try {
      await api.regenerate(conversationId, lastUserMsg.dbId);
    } catch (error) {
      // Bail out here — don't touch the view or resend. `api.regenerate`
      // failing (e.g. the run-lease 409 when another tab/device is mid-turn
      // on this conversation) means the server deleted nothing, so slicing
      // messages locally and re-streaming would both show a UI missing
      // messages that still exist server-side AND immediately hit its own
      // 409. Same "surface it, don't invent new UI" pattern as the file-
      // upload failure alert above.
      showAlert(
        `重新生成失败：${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    dispatch({ type: "truncated_from", id: lastUserMsg.id });

    streamMessage(lastUserContent, [], lastUserAttachments, undefined, lastUserKnowledgeBases);
  }, [state.messages, state.isStreaming, conversationId, streamMessage]);

  const generateMedia = useCallback(
    (prompt: string, mediaType: "image" | "video", settings?: unknown, files: PickedFile[] = [], modelId?: string) => {
      const cid = cidRef.current;
      if (!cid || !prompt.trim() || state.isStreaming) return;
      dispatch({ type: "stream_started" });

      if (genPollRef.current) genPollRef.current.cancelled = true;
      const token = { cancelled: false };
      genPollRef.current = token;

      // Optimistically render the user message + a "生成中" bubble immediately —
      // before the reference-image upload and create request resolve — so the
      // user sees "图片/视频生成中" right away instead of a stuck input box.
      // The placeholders are reconciled with server ids once /generations returns
      // (or flipped to "failed" if the request errors).
      const tempUserId = `user-${randomId()}`;
      const tempGenId = `assistant-${randomId()}`;
      dispatch({
        type: "generation_pair_appended",
        userMessage: { id: tempUserId, role: "user", content: prompt },
        genMessage: {
          id: tempGenId,
          role: "assistant",
          content: "",
          generation: { mediaType, status: "generating", progress: 0 },
        },
      });

      (async () => {
        try {
          const uploaded = files.length
            ? await Promise.all(files.map(async (f) => ({ slot: f.slot, uploaded: await api.uploadFile(f.file) })))
            : [];
          const media = uploaded
            .filter((f) => mediaType === "image" && f.uploaded.mime.startsWith("image/"))
            .map((f) => ({ type: "reference_image" as const, url: f.uploaded.url }));
          const urlsFor = (slot: PickedFile["slot"]) =>
            uploaded.filter((f) => f.slot === slot).map((f) => f.uploaded.url);
          const inputReference = urlsFor("video_reference_image");
          const referenceVideo = urlsFor("video_reference_video");
          const referenceAudio = urlsFor("video_reference_audio");
          const firstFrame = urlsFor("video_first_frame")[0];
          const lastFrame = urlsFor("video_last_frame")[0];

          const res = await api.generate(cid, {
            prompt,
            mediaType,
            settings,
            media: media.length ? media : undefined,
            input_reference: inputReference.length ? inputReference : undefined,
            reference_video: referenceVideo.length ? referenceVideo : undefined,
            reference_audio: referenceAudio.length ? referenceAudio : undefined,
            first_frame: firstFrame,
            last_frame: lastFrame,
            model: modelId,
          });
          if (token.cancelled) return;
          // Reconcile the optimistic placeholders with the server-assigned ids
          // + vendor taskId, keeping the bubble in its "generating" state.
          dispatch({
            type: "generation_ids_reconciled",
            tempUserId,
            userMessageId: res.userMessage.id,
            tempGenId,
            assistantMessageId: res.assistantMessage.id,
            generation: {
              mediaType,
              status: "generating",
              progress: 0,
              supportsProgress: res.assistantMessage.metadata?.supportsProgress,
              taskId: res.taskId,
            },
          });
          if (res.title) onTitleRef.current?.(cid, res.title);
          pollGeneration(res.taskId, res.assistantMessage.id, mediaType, token);
        } catch (e) {
          if (genPollRef.current === token) genPollRef.current = null;
          // The create request itself failed (non-2xx / network). Flip the
          // optimistic bubble to "failed" so the attempt + error stay visible.
          const msg = e instanceof Error ? e.message : String(e);
          dispatch({
            type: "generation_finished",
            messageId: tempGenId,
            generation: { mediaType, status: "failed", error: `生成请求失败：${msg}` },
          });
        }
      })();
    },
    [state.isStreaming, pollGeneration]
  );

  // Retry only the download of a generation left in "下载失败": the vendor media
  // already succeeded, so this re-fetches it server-side (no re-billing) and
  // resumes polling the new task. On success the card flips to the inline media.
  const redownloadGeneration = useCallback(
    (messageId: string, mediaType: "image" | "video") => {
      const cid = cidRef.current;
      if (!cid || state.isStreaming) return;
      dispatch({ type: "stream_started" });

      if (genPollRef.current) genPollRef.current.cancelled = true;
      const token = { cancelled: false };
      genPollRef.current = token;

      // Flip the card back to a live "生成中/下载中" state right away.
      dispatch({ type: "generation_progress", messageId, progress: 0 });

      (async () => {
        try {
          const res = await api.redownloadGeneration(cid, messageId);
          if (token.cancelled) return;
          pollGeneration(res.taskId, messageId, mediaType, token);
        } catch (e) {
          if (genPollRef.current === token) genPollRef.current = null;
          const msg = e instanceof Error ? e.message : String(e);
          dispatch({
            type: "generation_finished",
            messageId,
            generation: { mediaType, status: "download_failed", error: `重新下载失败：${msg}` },
          });
        }
      })();
    },
    [state.isStreaming, pollGeneration]
  );

  const stop = useCallback(() => {
    // Stop only the conversation on screen — a concurrent stream in another
    // conversation keeps running.
    const cid = cidRef.current;
    if (cid) {
      streamsRef.current.get(cid)?.abort();
      streamsRef.current.delete(cid);
    }
    if (genPollRef.current) { genPollRef.current.cancelled = true; genPollRef.current = null; }
    dispatch({ type: "stream_stopped" });
  }, []);

  const clear = useCallback(() => {
    // Cancel any in-flight generation poll and drop the streaming lock so a
    // resumed poll in the next conversation doesn't leave the input disabled.
    if (genPollRef.current) { genPollRef.current.cancelled = true; genPollRef.current = null; }
    setConversationKnowledgeBases([]);
    dispatch({ type: "cleared" });
  }, []);

  return {
    messages: state.messages,
    conversationModel: state.conversationModel,
    conversationKnowledgeBases,
    setConversationKnowledgeBases,
    send: streamMessage,
    stop,
    isStreaming: state.isStreaming,
    loadMessages,
    clear,
    regenerate,
    generateMedia,
    redownloadGeneration,
  };
}
