import type { CatalogModel } from "../lib/model-filter.js";
export type { CatalogModel };

export interface Conversation {
  id: string;
  title: string;
  agent_id: string;
  model?: string | null;
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
  metadata?: string | Record<string, unknown> | null;
  created_at: string;
}

export interface Rating {
  id: string;
  message_id: string;
  rating: number;
  feedback: string | null;
}

export interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "done" | "error" | "stream_end" | "artifact" | "title";
  id?: string;
  content?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  iterations?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  message?: string;
  // artifact variant
  assetId?: string;
  url?: string;
  mediaType?: string;
  // title variant
  title?: string;
}

export interface Agent {
  id: string;
  name: string;
  type: string;
  description: string;
  defaultModelId: string;
  toolNames: string[];
  inputSchema?: unknown;
  category?: string;
  installed?: boolean;
  sortOrder?: number | null;
}

export interface User {
  id: string;
  name: string;
  username: string | null;
}

export interface TaskStatus {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  progress: number;
  output?: {
    assetIds?: string[];
    assets?: { url: string; mime: string; durationSec?: number }[];
    url?: string;
    [key: string]: unknown;
  };
  error?: string;
}

export interface AssetMeta {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  created_at: string;
}

export type AttachmentSlot = "ppt_template" | "content" | "contract_old" | "contract_new";

/** 输入框选中的文件 + 它在消息里的角色（PPT 模版 / 内容素材 / 新旧合同）。 */
export interface PickedFile {
  file: File;
  slot?: AttachmentSlot;
}

export interface UploadedAttachment {
  assetId: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  kind: "image" | "doc";
  slot?: AttachmentSlot;
}

// ── Token management ──────────────────────────────────────────────────────────
const TOKEN_KEY = "lot_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const BASE = "/api";

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: callerHeaders, ...restInit } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    ...restInit,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(callerHeaders as Record<string, string> | undefined),
    },
  });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event("lot:unauthorized"));
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

export const api = {
  // ── Auth ────────────────────────────────────────────────────────────────────
  getPublicKey: () => request<{ publicKey: string }>("/auth/public-key"),

  login: (username: string, encryptedPassword: string) =>
    request<{ token: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, encryptedPassword }),
    }),

  logout: () =>
    request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  me: () => request<User>("/auth/me"),

  // ── Models (per-user dynamic catalog) ─────────────────────────────────────────
  listModels: () =>
    request<{ llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }>("/models"),

  // ── Agents ──────────────────────────────────────────────────────────────────
  listAgents: () => request<Agent[]>("/agents"),
  installAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${id}/install`, { method: "POST" }),
  uninstallAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${id}/install`, { method: "DELETE" }),
  promoteAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${id}/promote`, { method: "POST" }),

  // ── Conversations ───────────────────────────────────────────────────────────
  listConversations: (limit: number, cursor?: string) =>
    request<{ items: Conversation[]; nextCursor: string | null }>(
      `/conversations?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),

  createConversation: (title?: string, agentId?: string) =>
    request<Conversation>("/conversations", {
      method: "POST",
      body: JSON.stringify({ title, agentId }),
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

  uploadFile: async (file: File, signal?: AbortSignal): Promise<UploadedAttachment> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/uploads`, {
      method: "POST",
      headers: { ...authHeaders() }, // 不要手动设 Content-Type，浏览器自动带 boundary
      body: fd,
      signal,
    });
    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event("lot:unauthorized"));
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? res.statusText);
    }
    return res.json();
  },

  sendMessage: (
    conversationId: string,
    content: string,
    onEvent: (event: AgentEvent) => void | Promise<void>,
    attachments?: UploadedAttachment[],
    // Caller may pass its own controller so a single Stop aborts both the
    // file-upload phase and the SSE stream.
    controller: AbortController = new AbortController(),
    modelId?: string
  ): AbortController => {
    (async () => {
      try {
        const res = await fetch(
          `${BASE}/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeaders(),
            },
            body: JSON.stringify({ content, attachments, modelId }),
            signal: controller.signal,
          }
        );

        if (res.status === 401) {
          clearToken();
          window.dispatchEvent(new Event("lot:unauthorized"));
          onEvent({ type: "error", message: "Unauthorized" });
          return;
        }

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
              let event: AgentEvent | undefined;
              try {
                event = JSON.parse(line.slice(6)) as AgentEvent;
              } catch {
                // skip malformed lines
              }
              // Awaited so the handler can pace rendering (e.g. hold the
              // "tool executing" state briefly) while preserving event order.
              if (event) await onEvent(event);
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

  // ── Generation (image/video via conversation) ────────────────────────────
  generate: (
    conversationId: string,
    body: { prompt: string; mediaType: "image" | "video"; settings?: unknown; media?: { type: "reference_image"; url: string }[]; model?: string }
  ) =>
    request<{
      userMessage: { id: string; role: "user"; content: string };
      assistantMessage: {
        id: string;
        role: "assistant";
        status: string;
        metadata: { mediaType: "image" | "video"; status: string; supportsProgress?: boolean; assets?: { url: string; mime: string; durationSec?: number }[]; error?: string };
      };
      taskId: string;
      title?: string;
    }>(`/conversations/${conversationId}/generations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ── Tasks ───────────────────────────────────────────────────────────────────
  createTask: (type: "image.generate" | "video.generate", input: unknown) =>
    request<{ jobId: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ type, input }),
    }),

  getTask: (id: string) => request<TaskStatus>(`/tasks/${id}`),

  // ── Assets ──────────────────────────────────────────────────────────────────
  getAsset: (id: string) => request<AssetMeta>(`/assets/${id}`),

  // ── Ratings ─────────────────────────────────────────────────────────────────
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
