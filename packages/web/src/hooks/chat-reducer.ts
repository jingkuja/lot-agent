import type { PosterLayout } from "@lot-agent/core/poster";
import type { GenerationComposite, GenerationRedo, WhiteBackgroundCheck } from "../lib/image-settings.js";

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
  unknownResult?: boolean;
  /** Shown on the card itself: why an e-commerce scene request was not sent, or how many set images are missing. */
  notice?: string;
  taskId?: string;
  /** Image settings the server recorded for this generation; editing the image keeps them. */
  settings?: GenerationSettings;
  /** E-commerce image type of this generation; names each image of a set on the card. */
  scene?: string;
  /** Pictures joined from this generation's images (长图 / 宫格 / 一大多小). */
  composites?: GenerationComposite[];
  longImage?: boolean;
  /** Images of a set that were not made; 补齐 makes them. */
  missing?: number;
  /** 重做 / 补齐 in progress on this set, or why the last one made nothing. */
  redo?: GenerationRedo;
  /** 白底图: per image, whether the background was corrected and what may still fail a listing check. */
  whiteChecks?: WhiteBackgroundCheck[];
  /** 真实字体: per image, the wording typeset on it (null where an image has none); 改字 edits it for free. */
  posters?: (PosterLayout | null)[];
}

/** Later updates of a generation (ids, progress, final state) carry only what changed; what the card already knew stays. */
function keepGenerationContext(next: GenerationView, previous?: GenerationView): GenerationView {
  return {
    ...next,
    settings: next.settings ?? previous?.settings,
    scene: next.scene ?? previous?.scene,
    composites: next.composites ?? previous?.composites,
  };
}

export interface GenerationSettings {
  resolution?: string;
  ratio?: string;
  size?: string;
  n?: number;
  quality?: string;
}

/** Keeps only well-typed image settings from stored message metadata. */
export function generationSettings(raw: unknown): GenerationSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { resolution, ratio, size, n, quality } = raw as Record<string, unknown>;
  const settings: GenerationSettings = {
    ...(typeof resolution === "string" && resolution ? { resolution } : {}),
    ...(typeof ratio === "string" && ratio ? { ratio } : {}),
    ...(typeof size === "string" && size ? { size } : {}),
    ...(typeof n === "number" && Number.isInteger(n) && n > 0 ? { n } : {}),
    ...(typeof quality === "string" && quality ? { quality } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}

export interface DisplayMessage {
  feishuStatus?: string;
  conversationId?: string;
  runStatus?: import("@lot-agent/core").RunStatus;
  knowledgeSources?: import("../modules/knowledge/api.js").Evidence[];
  id: string;
  dbId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResult?: { name: string; output: string; isError: boolean; errorKind?: import("@lot-agent/core").ToolErrorKind };
  isStreaming?: boolean;
  rating?: number | null;
  attachments?: import("../api/client.js").UploadedAttachment[];
  imageInput?: import("../api/client.js").ImageInputContext;
  knowledgeBases?: import("../api/client.js").KnowledgeBaseRef[];
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
      errorKind?: import("@lot-agent/core").ToolErrorKind;
    }
  /** Turn ended (done / stream_end / error): finalize, drop the bubble if it has nothing to show. */
  | { type: "run_finished"; message: DisplayMessage }
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
      userContent?: string;
      imageInput?: DisplayMessage["imageInput"];
      tempGenId: string;
      assistantMessageId: string;
      generation: GenerationView;
    }
  | { type: "generation_progress"; messageId: string; progress?: number }
  /** Terminal generation state (completed/failed/cancelled) — also ends the streaming lock. */
  | { type: "generation_finished"; messageId: string; generation: GenerationView }
  /** A picture joined from a finished generation's images was stored. */
  | { type: "generation_composited"; messageId: string; composite: GenerationComposite }
  /** One typeset image was rendered again with new wording; pictures joined from the old one are gone. */
  | { type: "generation_poster_edited"; messageId: string; index: number; asset: { url: string; mime: string }; poster: PosterLayout }
  /** A redo was started on a finished set (the server reload brings its result). */
  | { type: "generation_redo_changed"; messageId: string; redo?: GenerationRedo };

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
        toolResult: { name: action.name, output: action.output, isError: action.isError, ...(action.errorKind ? { errorKind: action.errorKind } : {}) },
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

    case "run_finished":
      return { ...state, messages: upsert(state.messages, { ...action.message, isStreaming: false }) };

    case "turn_finalized": {
      const done = { ...action.message, isStreaming: false };
      // A bubble with neither text nor tool calls has nothing to show — drop
      // it (a thinking-only turn is persisted server-side and comes back on
      // the stream_end reload).
      const keep = Boolean(done.content) || Boolean(done.toolCalls?.length) || (!!done.runStatus && done.runStatus !== "completed");
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
        messages: [
          ...state.messages.filter((message) => message.id !== action.userMessage.id && message.id !== action.genMessage.id),
          action.userMessage, action.genMessage,
        ],
      };

    case "generation_ids_reconciled":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id === action.tempUserId)
            return {
              ...m, id: action.userMessageId, dbId: action.userMessageId,
              content: action.userContent ?? m.content, imageInput: action.imageInput ?? m.imageInput,
            };
          if (m.id === action.tempGenId)
            return {
              ...m,
              id: action.assistantMessageId,
              dbId: action.assistantMessageId,
              generation: keepGenerationContext(action.generation, m.generation),
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
          m.id === action.messageId
            ? { ...m, generation: keepGenerationContext(action.generation, m.generation) }
            : m
        ),
      };

    case "generation_redo_changed":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId && m.generation ? { ...m, generation: { ...m.generation, redo: action.redo } } : m
        ),
      };

    case "generation_poster_edited":
      return {
        ...state,
        messages: state.messages.map((m) => {
          const generation = m.generation;
          if (m.id !== action.messageId || !generation?.assets || action.index >= generation.assets.length) return m;
          const assets = generation.assets.map((asset, index) => (index === action.index ? action.asset : asset));
          const posters = assets.map((_, index) => (index === action.index ? action.poster : generation.posters?.[index] ?? null));
          return { ...m, generation: { ...generation, assets, posters, composites: undefined } };
        }),
      };

    case "generation_composited":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== action.messageId || !m.generation) return m;
          const { layout, gap } = action.composite;
          const others = (m.generation.composites ?? []).filter((item) => item.layout !== layout || item.gap !== gap);
          return { ...m, generation: { ...m.generation, composites: [...others, action.composite] } };
        }),
      };
  }
}
