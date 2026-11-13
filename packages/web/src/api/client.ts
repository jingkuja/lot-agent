import type { KnowledgeSourceType } from "@lot-agent/core";
import type { PosterFields, PosterLayout, PosterStyle, PosterTemplate } from "@lot-agent/core/poster";
import type {
  ComposeLayout, ExportPreset, GenerationComposite, GenerationRedo, PosterLibraryImage, PosterReference, SetRedoRequest,
} from "../lib/image-settings.js";
import type { CatalogModel } from "../lib/model-filter.js";
export type { CatalogModel };

export interface VideoPublication { copy: string; tags: string; }

export interface ConversationProject { id: string; name: string; }

export interface Conversation {
  channel?: "feishu" | null;
  project_id?: string | null;
  id: string;
  title: string;
  agent_id: string;
  model?: string | null;
  metadata?: Record<string, unknown>;
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
  type: "knowledge_sources" | "text" | "thinking" | "tool_call" | "tool_result" | "done" | "error" | "stream_end" | "artifact" | "title";
  id?: string;
  sources?: import("../modules/knowledge/api.js").Evidence[];
  /** tool_result variant: id of the tool_call this result answers. */
  toolCallId?: string;
  content?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  status?: import("@lot-agent/core").RunStatus;
  errorKind?: import("@lot-agent/core").ToolErrorKind;
  transportClosed?: boolean;
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

export interface PublicApiKey {
  key: string;
  name: string;
  group?: string;
}

export interface User {
  id: string;
  name: string;
  username: string | null;
  phone: string | null;
  apiKeys: PublicApiKey[];
  activeKeyIndex: number;
}

export interface RechargeOrder {
  transactionId: string;
  amount?: number | null;
  points?: number;
  currency?: string;
  quota?: number;
  status: "pending" | "payment_failed" | "paid" | "crediting" | "credited" | "credit_failed";
  createdAt?: string;
  orderSource?: string;
  paymentMethod?: string;
  paymentKind?: "qrcode" | "redirect";
  codeUrl?: string;
  payUrl?: string;
}

export interface RechargeInfo {
  enabled: boolean;
  paymentMethods: Array<{ name: string; type: string }>;
  amountDiscount: Record<string, number>;
}

export interface RechargeRecord {
  status?: string;
  refundedAmount?: number;
  transactionId: string;
  rechargedAt: string;
  paymentMethod: string;
  amount: number;
  currency: string;
}

export interface TaskStatus {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  output?: {
    assetIds?: string[];
    assets?: { url: string; mime: string; durationSec?: number }[];
    url?: string;
    /** Vendor generation succeeded but the server-side download of the media
     * failed; `sourceUrl` is the vendor url to retry the download from. */
    downloadFailed?: boolean;
    sourceUrl?: string;
    [key: string]: unknown;
  };
  error?: string;
}

export interface AssetMeta {
  id: string;
  url: string;
  filename: string;
  mediaType: string;
  size: number;
  created_at: string;
}

export interface ManagedUpload {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  createdAt: string;
}

export type AttachmentSlot =
  | "ppt_template" | "ppt_background" | "content" | "contract_old" | "contract_new"
  | "video_reference_image" | "video_reference_video" | "video_reference_audio"
  | "video_first_frame" | "video_last_frame";

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

export interface ImageInputContext {
  scene?: string;
  realText?: boolean;
  references: { url: string; kind: "poster" | "output" | "upload" }[];
}

export interface KnowledgeBaseRef {
  sourceTypes?: KnowledgeSourceType[];
  source?: "local" | "remote";
  id: string;
  name: string;
}

export interface KnowledgeBase extends KnowledgeBaseRef {
  description: string;
  documentCount: number;
  availableDocumentCount: number;
}

// ── Token management ──────────────────────────────────────────────────────────
// Delegated to token-store so the desktop shell can back it with the OS secure
// storage while the browser keeps using localStorage. Re-exported here because
// App.tsx / Login.tsx historically import them from the API client.
import { clearToken, getToken, setToken } from "../lib/token-store.js";
export { getToken, setToken, clearToken };

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const BASE = "/api";

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details: Record<string, unknown> = {},
    /** How long the server asked to wait, from `Retry-After`. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: callerHeaders, ...restInit } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    ...restInit,
    headers: {
      ...(restInit.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
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
    const retryAfter = Number(res.headers.get("Retry-After"));
    const message = typeof err.error === "object" ? err.error?.message ?? res.statusText : err.error ?? res.statusText;
    throw new ApiClientError(message, res.status, err.error?.code ?? err.code, err, retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  return res.json();
}

export interface AgentRunRecord {
  id: string;
  status: string;
  steps: Array<{ id: string; tool_name: string; status: string; input: unknown; result?: { content?: string } }>;
}

export const api = {
  imageShare: (url: string, signal?: AbortSignal) =>
    request<{ token: string | null }>(`/assets/shares?${new URLSearchParams({ url })}`, { signal }),
  createImageShare: (url: string) => request<{ token: string }>("/assets/shares", {
    method: "POST", body: JSON.stringify({ url }),
  }),
  revokeImageShare: (token: string) => request<{ ok: boolean }>(`/assets/shares/${encodeURIComponent(token)}`, { method: "DELETE" }),
  getAgentRuns: (conversationId: string) => request<{ runs: AgentRunRecord[] }>(`/conversations/${encodeURIComponent(conversationId)}/runs`),
  verifyAgentOperation: (conversationId: string, operationId: string, outcome: "succeeded" | "failed") =>
    request<{ ok: boolean }>(`/conversations/${encodeURIComponent(conversationId)}/operations/${encodeURIComponent(operationId)}/verify`, {
      method: "POST", body: JSON.stringify({ outcome }),
    }),
  getFileLinks: (urls: string[]) => request<{ links: Record<string, string> }>("/assets/links", {
    method: "POST", body: JSON.stringify({ urls }),
  }),
  getProductLinks: (signal?: AbortSignal) => request<{
    webUrl: string; tokenhubUrl: string; globle?: number; showCompliance?: boolean; [flag: string]: unknown;
  }>("/public/product", { signal }),
  // ── Auth ────────────────────────────────────────────────────────────────────
  getPublicKey: () => request<{ publicKey: string }>("/auth/public-key"),

  login: (username: string, encryptedPassword: string) =>
    request<{ token: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, encryptedPassword }),
    }),

  phoneLogin: (phone: string, verificationCode: string) =>
    request<{ token: string; user: User }>("/auth/phone-login", {
      method: "POST",
      body: JSON.stringify({ phone, verificationCode }),
    }),

  sendEmailVerification: (email: string) =>
    request<{ ok: true; expiresIn: number; resendAfter: number }>("/auth/verification/email", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  requestPasswordReset: (email: string) =>
    request<{ ok: true; expiresIn: number; resendAfter: number }>("/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  confirmPasswordReset: (args: {
    email: string;
    token: string;
    password: string;
    confirmPassword: string;
  }) =>
    request<{ ok: true }>("/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify(args),
    }),

  sendPhoneVerification: (phone: string, purpose: "register" | "login") =>
    request<{ ok: true; expiresIn: number; resendAfter: number }>("/auth/verification/phone", {
      method: "POST",
      body: JSON.stringify({ phone, purpose }),
    }),

  sendPhoneBindingVerification: (phone: string) =>
    request<{ ok: true; expiresIn: number; resendAfter: number }>("/auth/phone-binding/verification", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),

  bindPhone: (phone: string, verificationCode: string) =>
    request<{ ok: true; phone: string }>("/auth/phone-binding", {
      method: "POST",
      body: JSON.stringify({ phone, verificationCode }),
    }),

  register: (args: {
    username: string;
    encryptedPassword: string;
    email?: string;
    emailVerificationCode?: string;
    phone?: string;
    phoneVerificationCode?: string;
    requestId: string;
  }) =>
    request<{ token: string; user: User }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(args),
    }),

  // Public: exchange a tokenhub-issued JWT (from a `?token=` deep link) for a session.
  tokenLogin: (token: string) =>
    request<{ token: string; user: User }>("/auth/token-login", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  logout: () =>
    request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  me: () => request<User>("/auth/me"),

  // Public: whether the server runs in login-less debug mode, and the debug user.
  mode: () => request<{ debug: boolean; user: User | null; managedRegistration?: boolean }>("/auth/mode"),

  getRechargeInfo: () => request<RechargeInfo>("/recharge/info"),
  getRechargeHistory: (page = 1) => request<{
    records: RechargeRecord[];
    page: number;
    pageSize: number;
    total: number;
  }>(`/recharge/orders?page=${page}`),
  createRechargeOrder: (points: number, paymentMethod: string) =>
    request<RechargeOrder>("/recharge/orders", {
      method: "POST",
      body: JSON.stringify({ points, paymentMethod }),
    }),
  getRechargeOrder: (transactionId: string) =>
    request<RechargeOrder>(`/recharge/orders/${encodeURIComponent(transactionId)}`),
  getManagedBalance: () => request<{
    balance: number;
    totalUsed: number;
    totalRecharged: number;
    usedRatio: number;
    status?: string;
    allowBalanceFallback?: boolean;
  }>("/usage/balance"),
  setManagedBalanceFallback: (enabled: boolean) =>
    request<{ enabled: boolean }>("/usage/balance-fallback", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

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

  listProjects: () => request<ConversationProject[]>("/conversations/projects"),
  createProject: (name: string) => request<ConversationProject>("/conversations/projects", { method: "POST", body: JSON.stringify({ name }) }),
  projectConversations: (id: string) => request<Conversation[]>(`/conversations/projects/${id}/conversations`),
  moveConversation: (id: string, projectId: string | null) => request<Conversation>(`/conversations/${id}/project`, { method: "PUT", body: JSON.stringify({ projectId }) }),
  // ── Conversations ───────────────────────────────────────────────────────────
  listConversations: (limit: number, cursor?: string) =>
    request<{ items: Conversation[]; nextCursor: string | null }>(
      `/conversations?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),

  createConversation: (title?: string, agentId?: string, featureScope?: string, projectId?: string) =>
    request<Conversation>("/conversations", {
      method: "POST",
      body: JSON.stringify({ title, agentId, featureScope, projectId }),
    }),

  getConversation: (id: string) =>
    request<Conversation & { messages: StoredMessage[] }>(
      `/conversations/${id}`
    ),

  setConversationKnowledgeBases: (id: string, knowledgeBaseIds: string[], knowledgeSourceTypes?: KnowledgeSourceType[]) =>
    request<{ knowledgeBases: KnowledgeBaseRef[] }>(`/conversations/${id}/knowledge-bases`, {
      method: "PUT",
      body: JSON.stringify({ knowledgeBaseIds, knowledgeSourceTypes }),
    }),

  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/conversations/${id}`, { method: "DELETE" }),

  regenerate: (conversationId: string, afterMessageId: string) =>
    request<{ ok: boolean }>(`/conversations/${conversationId}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ afterMessageId }),
    }),

  uploadFile: async (file: File, signal?: AbortSignal, purpose?: "marketing-video" | "image-compose"): Promise<UploadedAttachment> => {
    // The file itself is the body, so the server streams it to disk instead of buffering a form.
    const res = await fetch(`${BASE}/uploads${purpose ? `?purpose=${purpose}` : ""}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
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
    modelId?: string,
    knowledgeBaseIds?: string[],
    knowledgeSourceTypes?: KnowledgeSourceType[]
  ): AbortController => {
    (async () => {
      let localPrepared = false;
      try {
        controller.signal.throwIfAborted();
        localPrepared = await window.lotDesktop?.prepareLocalTools(conversationId) ?? false;
        controller.signal.throwIfAborted();
        const res = await fetch(
          `${BASE}/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeaders(),
            },
            body: JSON.stringify({ content, attachments, modelId, knowledgeBaseIds, knowledgeSourceTypes }),
            signal: controller.signal,
          }
        );

        if (res.status === 401) {
          clearToken();
          window.dispatchEvent(new Event("lot:unauthorized"));
          onEvent({ type: "error", transportClosed: true, message: "Unauthorized" });
          return;
        }

        if (!res.ok) {
          // Surface the server's actual reason (e.g. the run-lease 409 —
          // "对话正在处理另一条消息，请稍候再试") instead of a generic
          // message, same pattern as `request()`/`uploadFile` above.
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          onEvent({ type: "error", transportClosed: true, message: err.error ?? "Request failed" });
          return;
        }
        if (!res.body) {
          onEvent({ type: "error", transportClosed: true, message: "Request failed" });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamEnded = false;

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
              if (event?.type === "stream_end") {
                streamEnded = true;
                if (localPrepared) {
                  await window.lotDesktop?.finishLocalTools(conversationId).catch(() => {});
                  localPrepared = false;
                }
              }
              if (event) await onEvent(event);
            }
          }
        }
        if (!streamEnded) await onEvent({ type: "error", transportClosed: true, message: "Connection closed before the turn was finalized" });
      } catch (error) {
        if (!controller.signal.aborted) {
          onEvent({
            type: "error", transportClosed: true,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (localPrepared) await window.lotDesktop?.finishLocalTools(conversationId).catch(() => {});
      }
    })();

    return controller;
  },

  listKnowledgeBases: () =>
    request<{ data: KnowledgeBase[] }>("/knowledge-bases"),

  getKnowledgeBaseLink: () =>
    request<{ url: string }>("/knowledge-bases/link", { method: "POST" }),

  // ── Generation (image/video via conversation) ────────────────────────────
  posterCategories: (signal?: AbortSignal) => request<{ categories: string[]; orientations?: boolean }>("/poster-library/categories", { signal }),
  posterImages: (category: string, offset: number, signal?: AbortSignal, query = "", orientation = "all") =>
    request<{ items: PosterLibraryImage[]; nextOffset: number | null }>(
      `/poster-library/images?${new URLSearchParams({ category, offset: String(offset), q: query, orientation })}`, { signal }
    ),

  generate: (
    conversationId: string,
    body: {
      prompt: string;
      mediaType: "image" | "video";
      settings?: unknown;
      media?: { type: "reference_image"; url: string }[];
      input_reference?: string | string[];
      reference_video?: string | string[];
      reference_audio?: string | string[];
      first_frame?: string;
      last_frame?: string;
      model?: string;
      /** Image scene; omitted for 自由创作. */
      scene?: string;
      posterReference?: PosterReference;
      /** 真实字体: typeset the wording on a text-free picture. */
      realText?: boolean;
      requestId?: string;
      regenerateFrom?: string;
    },
    signal?: AbortSignal,
  ) =>
    request<{
      userMessage: { id: string; content?: string; metadata?: { imageInput?: ImageInputContext } };
      assistantMessage: {
        id: string;
        role: "assistant";
        status: string;
        metadata: {
          mediaType: "image" | "video";
          status: string;
          supportsProgress?: boolean;
          assets?: { url: string; mime: string; durationSec?: number }[];
          error?: string;
          settings?: unknown;
        };
      };
      taskId: string;
      title?: string;
    }>(`/conversations/${conversationId}/generations`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),

  // Retry only the download of a generation whose vendor media succeeded but
  getImageSubmission: (conversationId: string, requestId: string) =>
    request<{
      taskId: string; title?: string;
      userMessage: { id: string; content?: string; metadata?: { imageInput?: ImageInputContext } };
      assistantMessage: { id: string; metadata?: { supportsProgress?: boolean; settings?: unknown; scene?: string } };
    }>(`/conversations/${conversationId}/generations/submissions/${encodeURIComponent(requestId)}`),

  whiteBackground: (conversationId: string, messageId: string, index: number, restore: boolean) =>
    request(`/conversations/${conversationId}/generations/${messageId}/white-background`, {
      method: "POST", body: JSON.stringify({ index, restore }),
    }),

  // whose server-side download failed (card in "下载失败" state). Returns the
  // new taskId to poll.
  redownloadGeneration: (conversationId: string, messageId: string) =>
    request<{ taskId: string }>(
      `/conversations/${conversationId}/generations/${messageId}/redownload`,
      { method: "POST" }
    ),

  /** 打包下载: the zip itself (not JSON); errors come back as the usual ApiClientError. */
  exportGeneration: async (
    conversationId: string, messageId: string, body: { preset: ExportPreset; names: string[]; compositeNames: string[] },
  ): Promise<Blob> => {
    const res = await fetch(`${BASE}/conversations/${conversationId}/generations/${messageId}/export`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body),
    });
    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event("lot:unauthorized"));
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiClientError(typeof err.error === "string" ? err.error : res.statusText, res.status, err.code, err);
    }
    return res.blob();
  },

  redoGeneration: (conversationId: string, messageId: string, body: SetRedoRequest) =>
    request<{ taskId: string; redo: GenerationRedo }>(
      `/conversations/${conversationId}/generations/${messageId}/redo`,
      { method: "POST", body: JSON.stringify(body) }
    ),

  /** 真实字体: change one typeset image's wording or template; rendered again on the server, free. */
  editPoster: (conversationId: string, messageId: string, body: { index: number; fields: PosterFields; template: PosterTemplate; style?: PosterStyle }) =>
    request<{ index: number; asset: { url: string; mime: string }; poster: PosterLayout }>(
      `/conversations/${conversationId}/generations/${messageId}/poster`,
      { method: "POST", body: JSON.stringify(body) }
    ),

  /** 改字预览: the rendered picture for unsaved wording and style; nothing is stored. */
  previewPoster: async (
    conversationId: string, messageId: string, body: { index: number; fields: PosterFields; template: PosterTemplate; style?: PosterStyle },
  ): Promise<Blob> => {
    const res = await fetch(`${BASE}/conversations/${conversationId}/generations/${messageId}/poster/preview`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body),
    });
    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event("lot:unauthorized"));
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiClientError(typeof err.error === "string" ? err.error : res.statusText, res.status, err.code, err);
    }
    return res.blob();
  },

  composeGeneration: (conversationId: string, messageId: string, body: { layout: ComposeLayout; gap: boolean }) =>
    request<{ composite: GenerationComposite }>(
      `/conversations/${conversationId}/generations/${messageId}/compose`,
      { method: "POST", body: JSON.stringify(body) }
    ),

  /** 图片合成 from the composer: join picked images into one picture, posted to the conversation as a finished image. */
  composeImages: (conversationId: string, body: { urls: string[]; layout: ComposeLayout; gap: boolean; prompt: string }) =>
    request<{
      userMessage: { id: string; role: "user"; content: string };
      assistantMessage: { id: string; role: "assistant"; status: "completed"; metadata: { assets: { url: string; mime: string }[] } };
    }>(`/conversations/${conversationId}/compose`, { method: "POST", body: JSON.stringify(body) }),

  // ── Tasks ───────────────────────────────────────────────────────────────────
  createTask: (type: "image.generate" | "video.generate", input: unknown) =>
    request<{ jobId: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ type, input }),
    }),

  getTask: (id: string) => request<TaskStatus>(`/tasks/${id}`),

  cancelTask: (id: string) =>
    request<{ ok: boolean; status: string }>(`/tasks/${id}/cancel`, { method: "POST" }),

  // ── Assets ──────────────────────────────────────────────────────────────────
  getAsset: (id: string) => request<AssetMeta>(`/assets/${id}`),

  listUploadedFiles: () => request<{ data: ManagedUpload[] }>("/assets"),

  deleteUploadedFile: (id: string) =>
    request<{ ok: boolean }>(`/assets/${id}`, { method: "DELETE" }),

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
