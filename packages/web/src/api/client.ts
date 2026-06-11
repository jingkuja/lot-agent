export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  rating?: number | null;
  created_at: string;
}

export interface Rating {
  id: string;
  message_id: string;
  rating: number;
  feedback: string | null;
}

export interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "done" | "error" | "stream_end";
  id?: string;
  content?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  iterations?: number;
  totalTokens?: number;
  message?: string;
}

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

export const api = {
  listConversations: () => request<Conversation[]>("/conversations"),

  createConversation: (title?: string) =>
    request<Conversation>("/conversations", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  getConversation: (id: string) =>
    request<Conversation & { messages: StoredMessage[] }>(
      `/conversations/${id}`
    ),

  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/conversations/${id}`, { method: "DELETE" }),

  regenerate: (conversationId: string, afterMessageId: string) =>
    request<{ ok: boolean }>(`/conversations/${conversationId}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ afterMessageId }),
    }),

  sendMessage: (
    conversationId: string,
    content: string,
    onEvent: (event: AgentEvent) => void
  ): AbortController => {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(
          `${BASE}/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
            signal: controller.signal,
          }
        );

        if (!res.ok || !res.body) {
          onEvent({ type: "error", message: "Request failed" });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6)) as AgentEvent;
                onEvent(event);
              } catch {
                // skip malformed lines
              }
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          onEvent({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return controller;
  },

  // Ratings
  setRating: (messageId: string, rating: number, feedback?: string) =>
    request<Rating>(`/ratings/${messageId}`, {
      method: "POST",
      body: JSON.stringify({ rating, feedback }),
    }),

  getRating: (messageId: string) =>
    request<Rating | null>(`/ratings/${messageId}`),

  removeRating: (messageId: string) =>
    request<{ ok: boolean }>(`/ratings/${messageId}`, { method: "DELETE" }),
};
