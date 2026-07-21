export interface GenerationView {
  mediaType: "image" | "video";
  /** `download_failed`: the vendor produced the media but the server-side
   * download of it failed — recoverable, the card offers a re-download. */
  status: "generating" | "completed" | "failed" | "cancelled" | "download_failed";
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
  thinking?: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResult?: { name: string; output: string; isError: boolean };
  isStreaming?: boolean;
  rating?: number | null;
  attachments?: import("../api/client.js").UploadedAttachment[];
  generation?: GenerationView;
}

export interface ChatState {
  messages: DisplayMessage[];
  conversationModel: string | null;
  isStreaming: boolean;
}

export const initialChatState: ChatState = {
  messages: [],
  conversationModel: null,
  isStreaming: false,
};

/**
 * Every view mutation of the chat panel, as data. The SSE handler / generation
 * poller / user actions in useChat only translate their events into these and
 * dispatch — all list manipulation lives here, testable as
 * "action sequence → view state".
 *
 * Streaming actions carry the WHOLE accumulated assistant message, not a
 * delta: a stream whose conversation is off-screen is not dispatched at all,
 * and re-attaches losslessly on its next event when the user switches back.
 * The accumulator therefore lives with the stream (closure), not in here.
 */
export type ChatAction =
  | { type: "stream_started" }
  | { type: "stream_stopped" }
  | { type: "cleared" }
  | {
      type: "snapshot_loaded";
      messages: DisplayMessage[];
      model: string | null;
      isStreaming: boolean;
    }
  | { type: "user_appended"; message: DisplayMessage }
  /** Streaming upsert of the accumulating assistant message (text/thinking/tool_call). */
  | { type: "assistant_upserted"; message: DisplayMessage }
  /** A tool finished: finalize the assistant message that called it, append the result card. */
  | {
      type: "tool_result_appended";
      assistantId: string;
      cardId: string;
      name: string;
      output: string;
      isError: boolean;
    }
  /** Turn ended (done / stream_end / error): finalize, drop the bubble if it has nothing to show. */
  | { type: "turn_finalized"; message: DisplayMessage }
  /** Regenerate: cut the tail of the list starting at this message (inclusive). */
  | { type: "truncated_from"; id: string }
  /** Optimistic user + "生成中" bubble pair, before /generations resolves. */
  | { type: "generation_pair_appended"; userMessage: DisplayMessage; genMessage: DisplayMessage }
  /** /generations resolved: swap optimistic ids for server ids + taskId. */
  | {
      type: "generation_ids_reconciled";
      tempUserId: string;
      userMessageId: string;
      tempGenId: string;
      assistantMessageId: string;
      generation: GenerationView;
    }
  | { type: "generation_progress"; messageId: string; progress?: number }
  /** Terminal generation state (completed/failed/cancelled) — also ends the streaming lock. */
  | { type: "generation_finished"; messageId: string; generation: GenerationView };

/** Update the message with `message.id` in place, or append it if absent. */
function upsert(messages: DisplayMessage[], message: DisplayMessage): DisplayMessage[] {
  let found = false;
  const next = messages.map((m) => {
    if (m.id !== message.id) return m;
    found = true;
    return message;
  });
  return found ? next : [...messages, message];
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "stream_started":
      return { ...state, isStreaming: true };

    case "stream_stopped":
      return { ...state, isStreaming: false };

    case "cleared":
      return initialChatState;

    case "snapshot_loaded":
      return {
        messages: action.messages,
        conversationModel: action.model,
        isStreaming: action.isStreaming,
      };

    case "user_appended":
      return { ...state, messages: [...state.messages, action.message] };

    case "assistant_upserted":
      return {
        ...state,
        messages: upsert(state.messages, { ...action.message, isStreaming: true }),
      };

    case "tool_result_appended": {
      const card: DisplayMessage = {
        id: action.cardId,
        role: "tool",
        content: "",
        toolResult: { name: action.name, output: action.output, isError: action.isError },
      };
      return {
        ...state,
        messages: [
          ...state.messages.map((m) =>
            m.id === action.assistantId ? { ...m, isStreaming: false } : m
          ),
          card,
        ],
      };
    }

    case "turn_finalized": {
      const done = { ...action.message, isStreaming: false };
      // A bubble with neither text nor tool calls has nothing to show — drop
      // it (a thinking-only turn is persisted server-side and comes back on
      // the stream_end reload).
      const keep = Boolean(done.content) || Boolean(done.toolCalls?.length);
      return {
        ...state,
        isStreaming: false,
        messages: keep
          ? upsert(state.messages, done)
          : state.messages.filter((m) => m.id !== done.id),
      };
    }

    case "truncated_from": {
      let idx = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].id === action.id) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return state;
      return { ...state, messages: state.messages.slice(0, idx) };
    }

    case "generation_pair_appended":
      return {
        ...state,
        messages: [...state.messages, action.userMessage, action.genMessage],
      };

    case "generation_ids_reconciled":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id === action.tempUserId)
            return { ...m, id: action.userMessageId, dbId: action.userMessageId };
          if (m.id === action.tempGenId)
            return {
              ...m,
              id: action.assistantMessageId,
              dbId: action.assistantMessageId,
              generation: action.generation,
            };
          return m;
        }),
      };

    case "generation_progress":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId && m.generation
            ? {
                ...m,
                generation: { ...m.generation, status: "generating", progress: action.progress },
              }
            : m
        ),
      };

    case "generation_finished":
      return {
        ...state,
        isStreaming: false,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, generation: action.generation } : m
        ),
      };
  }
}
