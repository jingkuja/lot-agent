import type { CatalogModel } from "../lib/model-filter.js";
import type {
  CustomerObservation,
  CustomerProductState,
  CustomerProfile,
  MarketingBrandAssets,
  MarketingProduct,
  MarketingProductInput,
  MarketingProductListResponse,
  CustomerStateChange,
  DigitalEmployeeOverview,
  ManualObservationInput,
  ProductStateUpdateInput,
  ProfileDetailResponse,
  ProfileInput,
  ProfileListResponse,
  ProfileUpdateInput,
  OpportunityListResponse,
  OpportunitySettings,
  TalkTrackIntent,
  TalkTrackMessage,
  OpportunityView,
  CustomerSegment,
  CustomerSegmentCriteria,
  CustomerSegmentSnapshot,
  AcquisitionInsights,
  CampaignRecommendation,
  AcquisitionModelConfiguration,
  MarketingAsset,
  MarketingAssetListResponse,
  DeploymentPlatform,
  AssetDeployment,
  DeploymentFeedback,
  AcquisitionAnalytics,
  MarketingCampaignSummary,
  MarketingCampaignDetail,
  CampaignOpportunity,
} from "../modules/digital-employee/types.js";
export type { CatalogModel };

export interface Conversation {
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
  type: "text" | "thinking" | "tool_call" | "tool_result" | "done" | "error" | "stream_end" | "artifact" | "title";
  id?: string;
  /** tool_result variant: id of the tool_call this result answers. */
  toolCallId?: string;
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

export interface PublicApiKey {
  key: string;
  name: string;
  group?: string;
}

export interface User {
  id: string;
  name: string;
  username: string | null;
  apiKeys: PublicApiKey[];
  activeKeyIndex: number;
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

export interface KnowledgeBaseRef {
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
  ) {
    super(message);
    this.name = "ApiClientError";
  }
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
    throw new ApiClientError(err.error ?? res.statusText, res.status, err.code, err);
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
  mode: () => request<{ debug: boolean; user: User | null }>("/auth/mode"),

  setActiveKey: (index: number) =>
    request<{ ok: boolean; activeKeyIndex: number }>("/keys/active", {
      method: "POST",
      body: JSON.stringify({ index }),
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

  // ── Conversations ───────────────────────────────────────────────────────────
  listConversations: (limit: number, cursor?: string) =>
    request<{ items: Conversation[]; nextCursor: string | null }>(
      `/conversations?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    ),

  createConversation: (title?: string, agentId?: string, featureScope?: string) =>
    request<Conversation>("/conversations", {
      method: "POST",
      body: JSON.stringify({ title, agentId, featureScope }),
    }),

  getConversation: (id: string) =>
    request<Conversation & { messages: StoredMessage[] }>(
      `/conversations/${id}`
    ),

  setConversationKnowledgeBases: (id: string, knowledgeBaseIds: string[]) =>
    request<{ knowledgeBases: KnowledgeBaseRef[] }>(`/conversations/${id}/knowledge-bases`, {
      method: "PUT",
      body: JSON.stringify({ knowledgeBaseIds }),
    }),

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
    modelId?: string,
    knowledgeBaseIds?: string[]
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
            body: JSON.stringify({ content, attachments, modelId, knowledgeBaseIds }),
            signal: controller.signal,
          }
        );

        if (res.status === 401) {
          clearToken();
          window.dispatchEvent(new Event("lot:unauthorized"));
          onEvent({ type: "error", message: "Unauthorized" });
          return;
        }

        if (!res.ok) {
          // Surface the server's actual reason (e.g. the run-lease 409 —
          // "对话正在处理另一条消息，请稍候再试") instead of a generic
          // message, same pattern as `request()`/`uploadFile` above.
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          onEvent({ type: "error", message: err.error ?? "Request failed" });
          return;
        }
        if (!res.body) {
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

  listKnowledgeBases: () =>
    request<{ data: KnowledgeBase[] }>("/knowledge-bases"),

  getKnowledgeBaseLink: () =>
    request<{ url: string }>("/knowledge-bases/link", { method: "POST" }),

  // ── Generation (image/video via conversation) ────────────────────────────
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
    }
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

  // Retry only the download of a generation whose vendor media succeeded but
  // whose server-side download failed (card in "下载失败" state). Returns the
  // new taskId to poll.
  redownloadGeneration: (conversationId: string, messageId: string) =>
    request<{ taskId: string }>(
      `/conversations/${conversationId}/generations/${messageId}/redownload`,
      { method: "POST" }
    ),

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

  // ── Digital employee / customer profiles ──────────────────────────────────
  getDigitalEmployeeOverview: () =>
    request<DigitalEmployeeOverview>("/digital-employee/overview"),

  listCustomerProfiles: (filters: {
    page?: number;
    limit?: number;
    q?: string;
    relationshipStage?: string;
    health?: string;
    tag?: string;
    status?: string;
  } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<ProfileListResponse>(`/digital-employee/profiles${suffix ? `?${suffix}` : ""}`);
  },

  getCustomerProfile: (id: string) =>
    request<ProfileDetailResponse>(`/digital-employee/profiles/${encodeURIComponent(id)}`),

  createCustomerProfile: (input: ProfileInput) =>
    request<ProfileDetailResponse>("/digital-employee/profiles", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateCustomerProfile: (id: string, input: ProfileUpdateInput) =>
    request<CustomerProfile>(`/digital-employee/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  archiveCustomerProfile: (id: string, version: number, onOpenTasks?: "cancel" | "keep") =>
    request<CustomerProfile>(`/digital-employee/profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ version, onOpenTasks }),
    }),

  updateCustomerProductState: (profileId: string, productKey: string, input: ProductStateUpdateInput) =>
    request<{ profile: CustomerProfile; productState: CustomerProductState }>(
      `/digital-employee/profiles/${encodeURIComponent(profileId)}/products/${encodeURIComponent(productKey)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    ),

  addCustomerObservation: (profileId: string, input: ManualObservationInput) =>
    request<{
      profile: CustomerProfile;
      observation: CustomerObservation;
      extraction: unknown;
      appliedFields: string[];
      skippedFields: string[];
    }>(`/digital-employee/profiles/${encodeURIComponent(profileId)}/observations`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getCustomerTimeline: (profileId: string) =>
    request<{ observations: CustomerObservation[]; changes: CustomerStateChange[] }>(
      `/digital-employee/profiles/${encodeURIComponent(profileId)}/timeline`
    ),

  clearDigitalEmployeeContext: (conversationId: string) =>
    request<{ ok: boolean }>(
      `/digital-employee/conversation-context/${encodeURIComponent(conversationId)}`,
      { method: "DELETE" }
    ),

  listOpportunities: (filters: { view: OpportunityView; readiness?: string; priority?: string; opportunityType?: string; relationshipStage?: string; product?: string; suggestedFrom?: string; suggestedTo?: string }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    return request<OpportunityListResponse>(`/digital-employee/opportunities?${query.toString()}`);
  },

  discoverOpportunities: () => request<{ runId: string; taskId: string; reused: boolean }>("/digital-employee/opportunities/discover", { method: "POST" }),
  createOpportunityAction: (input: Record<string, unknown>) =>
    request<import("../modules/digital-employee/types.js").OpportunityItem>("/digital-employee/actions", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  decideOpportunity: (id: string, input: Record<string, unknown>) =>
    request<{ opportunityId: string; status: string; actionId?: string }>(`/digital-employee/opportunities/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify(input),
    }),

  generateOpportunityTalkTrack: (id: string, input: { intent: TalkTrackIntent; message: string; history: TalkTrackMessage[] }) =>
    request<{ reply: string; modelId: string }>(`/digital-employee/opportunities/${encodeURIComponent(id)}/talk-track`, {
      method: "POST", body: JSON.stringify(input),
    }),

  updateOpportunityAction: (id: string, input: Record<string, unknown>) =>
    request<import("../modules/digital-employee/types.js").OpportunityItem>(`/digital-employee/actions/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify(input),
    }),

  addOpportunityActionResult: (id: string, input: Record<string, unknown>) =>
    request<{ recordId: string; actionId: string; status: string; nextActionId: string | null }>(`/digital-employee/actions/${encodeURIComponent(id)}/results`, {
      method: "POST", body: JSON.stringify(input),
    }),

  getOpportunitySettings: () => request<OpportunitySettings>("/digital-employee/opportunity-settings"),

  saveOpportunitySettings: (input: OpportunitySettings) => request<OpportunitySettings>("/digital-employee/opportunity-settings", {
    method: "PUT", body: JSON.stringify({ enabled: input.enabled, timezone: input.timezone, dailyRunTime: input.dailyRunTime, version: input.version }),
  }),

  listMarketingProducts: (filters: { q?: string; status?: string; page?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<MarketingProductListResponse>(`/digital-employee/marketing/products${suffix ? `?${suffix}` : ""}`);
  },

  createMarketingProduct: (input: MarketingProductInput) =>
    request<MarketingProduct>("/digital-employee/marketing/products", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateMarketingProduct: (id: string, input: Partial<MarketingProductInput> & { version: number }) =>
    request<MarketingProduct>(`/digital-employee/marketing/products/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  archiveMarketingProduct: (id: string, version: number) =>
    request<MarketingProduct>(`/digital-employee/marketing/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ version }),
    }),

  getMarketingBrandAssets: () =>
    request<MarketingBrandAssets | null>("/digital-employee/marketing/brand-assets"),

  saveMarketingBrandAssets: (input: Partial<Pick<MarketingBrandAssets, "tone" | "visualAssets" | "standardCallsToAction">> & { version?: number }) =>
    request<MarketingBrandAssets>("/digital-employee/marketing/brand-assets", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  listCustomerSegments: () =>
    request<{ items: CustomerSegment[] }>("/digital-employee/acquisition/segments"),

  createCustomerSegment: (input: { name: string; description?: string; criteria: CustomerSegmentCriteria }) =>
    request<CustomerSegment & { latestSnapshot: CustomerSegmentSnapshot }>("/digital-employee/acquisition/segments", {
      method: "POST", body: JSON.stringify(input),
    }),

  snapshotCustomerSegment: (id: string) =>
    request<CustomerSegmentSnapshot>(`/digital-employee/acquisition/segments/${encodeURIComponent(id)}/snapshots`, { method: "POST" }),

  getAcquisitionInsights: () => request<AcquisitionInsights>("/digital-employee/acquisition/insights"),

  listAcquisitionRecommendations: (status?: string) =>
    request<{ items: CampaignRecommendation[]; generatedAt: string | null }>(`/digital-employee/acquisition/recommendations${status ? `?status=${encodeURIComponent(status)}` : ""}`),

  refreshAcquisitionRecommendations: () =>
    request<{ items: CampaignRecommendation[]; generatedAt: string | null }>("/digital-employee/acquisition/recommendations/refresh", { method: "POST" }),

  updateAcquisitionRecommendation: (id: string, status: "adopted" | "ignored") =>
    request<CampaignRecommendation>(`/digital-employee/acquisition/recommendations/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ status }),
    }),

  getAcquisitionModelConfiguration: () =>
    request<AcquisitionModelConfiguration>("/digital-employee/acquisition/model-configuration"),

  listMarketingAssets: (filters: { range?: string; assetType?: string; page?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
    return request<MarketingAssetListResponse>(`/digital-employee/acquisition/assets?${query.toString()}`);
  },

  createMarketingAsset: (input: {
    assetType: "copy" | "poster" | "video"; prompt: string; segmentId?: string; segmentSnapshotId?: string;
    publicAudience?: string; productId: string; recommendationId?: string; parentAssetId?: string; campaignId?: string;
    objective: string; channels: string[]; callToAction: string; title?: string; durationSeconds?: number;
    modelId?: string; knowledgeBaseIds?: string[]; attachments?: UploadedAttachment[];
    mediaSettings?: { size?: string; n?: number; quality?: string; durationSec?: number; ratio?: string };
    input_reference?: string | string[]; reference_video?: string | string[]; reference_audio?: string | string[];
    first_frame?: string; last_frame?: string;
  }) => request<MarketingAsset>("/digital-employee/acquisition/assets", { method: "POST", body: JSON.stringify(input) }),

  getMarketingAsset: (id: string) => request<MarketingAsset>(`/digital-employee/acquisition/assets/${encodeURIComponent(id)}`),

  archiveMarketingAsset: (id: string) => request<{ assetId: string; status: "archived" }>(`/digital-employee/acquisition/assets/${encodeURIComponent(id)}`, { method: "DELETE" }),

  saveAssetDeployment: (assetId: string, input: { platform: DeploymentPlatform; customPlatform?: string; status: "pending" | "deployed" | "ended"; deployedAt?: string | null }) =>
    request<AssetDeployment>(`/digital-employee/acquisition/assets/${encodeURIComponent(assetId)}/deployments`, {
      method: "PUT", body: JSON.stringify(input),
    }),

  addDeploymentFeedback: (deploymentId: string, input: { impressions?: number | null; interactions?: number | null; conversions?: number | null; feedbackText?: string }) =>
    request<DeploymentFeedback>(`/digital-employee/acquisition/deployments/${encodeURIComponent(deploymentId)}/feedback`, {
      method: "POST", body: JSON.stringify(input),
    }),

  getAcquisitionAnalytics: () => request<AcquisitionAnalytics>("/digital-employee/acquisition/analytics"),

  returnAcquisitionLead: (input: {
    displayName: string; organization?: string | null; sourceCampaign?: string; productName?: string; quote?: string;
  }) => request<{ alreadyApplied: boolean; profile: CustomerProfile; action: { id: string; profileId: string; title: string } }>(
    "/digital-employee/acquisition/leads", { method: "POST", body: JSON.stringify(input) }
  ),

  listMarketingCampaigns: (filters: { status?: string; page?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
    return request<{ items: MarketingCampaignSummary[]; total: number; page: number; limit: number }>(
      `/digital-employee/acquisition/campaigns?${query.toString()}`
    );
  },

  createMarketingCampaign: (input: {
    name: string; objective: string; channels: string[]; callToAction: string; productId: string;
    segmentId?: string; segmentSnapshotId?: string; publicAudience?: string;
  }) => request<MarketingCampaignDetail>("/digital-employee/acquisition/campaigns", { method: "POST", body: JSON.stringify(input) }),

  getMarketingCampaign: (id: string) =>
    request<MarketingCampaignDetail>(`/digital-employee/acquisition/campaigns/${encodeURIComponent(id)}`),

  updateMarketingCampaign: (id: string, input: {
    name?: string; objective?: string; channels?: string[]; callToAction?: string;
    status?: string; selectedAssets?: Partial<Record<"copy" | "poster" | "video", string | null>>;
  }) => request<MarketingCampaignDetail>(
    `/digital-employee/acquisition/campaigns/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }
  ),

  listCampaignOpportunities: (status?: string) =>
    request<{ items: CampaignOpportunity[]; total: number }>(
      `/digital-employee/acquisition/campaign-opportunities${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),

  acceptCampaignOpportunity: (id: string) =>
    request<MarketingCampaignDetail>(
      `/digital-employee/acquisition/campaign-opportunities/${encodeURIComponent(id)}/accept`, { method: "POST" }
    ),

  dismissCampaignOpportunity: (id: string) =>
    request<{ opportunityId: string; status: string }>(
      `/digital-employee/acquisition/campaign-opportunities/${encodeURIComponent(id)}/dismiss`, { method: "POST" }
    ),
};
