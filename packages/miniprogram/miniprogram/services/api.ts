import { encryptPassword } from "../lib/rsa-oaep";
import { joinUrl, mediaUrl } from "../lib/url";
import { IMAGE_AGENT_ID } from "./config";
import {
  clearSession,
  getApiBase,
  getToken,
  isLoginPage,
} from "./session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CatalogModel {
  id: string;
  type: string;
}

export interface Conversation {
  id: string;
  title: string;
  agent_id: string;
  updated_at: string;
  preview_url?: string | null;
}

export interface TaskStatus {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | string;
  progress: number;
  output?: {
    assets?: Array<{ url: string; mime: string }>;
    downloadFailed?: boolean;
    sourceUrl?: string;
  };
  error?: string;
}

export interface GenerationResult {
  userMessage: { id: string; content: string };
  assistantMessage: {
    id: string;
    status: string;
    metadata: {
      status?: string;
      supportsProgress?: boolean;
      assets?: Array<{ url: string; mime: string }>;
      error?: string;
    };
  };
  taskId: string;
  title?: string;
}

function authHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function request<T>(path: string, init?: { method?: string; data?: unknown }): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: joinUrl(getApiBase(), `/api${path}`),
      method: init?.method ?? "GET",
      data: init?.data,
      header: {
        "Content-Type": "application/json",
        "X-Lot-Client": "miniprogram",
        ...authHeader(),
      },
      success(res) {
        if (res.statusCode === 401) {
          clearSession();
          if (!isLoginPage() && !getApp().globalData.debug) {
            wx.reLaunch({ url: "/pages/login/index" });
          }
          reject(new ApiError("请先登录", 401));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const body = (res.data ?? {}) as { error?: string; code?: string };
          reject(
            new ApiError(body.error || "请求失败", res.statusCode, body.code, body as Record<string, unknown>)
          );
          return;
        }
        resolve(res.data as T);
      },
      fail(err) {
        reject(new ApiError(err.errMsg || "网络错误", 0));
      },
    });
  });
}

export const api = {
  mode: () =>
    request<{
      debug: boolean;
      user: LotUser | null;
      managedRegistration: boolean;
      wechatLogin: boolean;
    }>("/auth/mode"),

  getPublicKey: () => request<{ publicKey: string }>("/auth/public-key"),

  async login(username: string, password: string) {
    const { publicKey } = await api.getPublicKey();
    const encryptedPassword = await encryptPassword(publicKey, password);
    return request<{ token: string; user: LotUser }>("/auth/login", {
      method: "POST",
      data: { username, encryptedPassword },
    });
  },

  phoneLogin: (phone: string, verificationCode: string) =>
    request<{ token: string; user: LotUser }>("/auth/phone-login", {
      method: "POST",
      data: { phone, verificationCode },
    }),

  sendPhoneVerification: (phone: string, purpose: "register" | "login") =>
    request<{ ok: true; expiresIn: number; resendAfter: number }>("/auth/verification/phone", {
      method: "POST",
      data: { phone, purpose },
    }),

  wechatLogin: (code: string) =>
    request<{ token?: string; user?: LotUser; needBind?: boolean; ticket?: string }>(
      "/auth/wechat-login",
      { method: "POST", data: { code } }
    ),

  wechatBind: (body: { ticket?: string; code?: string }) =>
    request<{ ok: true }>("/auth/wechat-bind", { method: "POST", data: body }),

  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  me: () => request<LotUser>("/auth/me"),

  models: () => request<{ llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }>("/models"),

  balance: () => request<{ balance: number; totalUsed?: number }>("/usage/balance"),

  createConversation: (title?: string) =>
    request<Conversation>("/conversations", {
      method: "POST",
      data: { title: title ?? "新对话", agentId: IMAGE_AGENT_ID },
    }),

  listImageConversations: (limit = 20, cursor?: string) => {
    const q = [
      `limit=${limit}`,
      "agentId=image",
      "includePreview=1",
      cursor ? `cursor=${encodeURIComponent(cursor)}` : "",
    ]
      .filter(Boolean)
      .join("&");
    return request<{ items: Conversation[]; nextCursor: string | null }>(`/conversations?${q}`);
  },

  getConversation: (id: string) =>
    request<Conversation & { messages: Array<{ id: string; role: string; content: string; metadata?: unknown }> }>(
      `/conversations/${id}`
    ),

  generate: (conversationId: string, body: {
    prompt: string;
    mediaType: "image";
    settings?: { size?: string; quality?: string; n?: number };
    media?: Array<{ type: "reference_image"; url: string }>;
    model?: string;
  }) =>
    request<GenerationResult>(`/conversations/${conversationId}/generations`, {
      method: "POST",
      data: body,
    }),

  getTask: (id: string) => request<TaskStatus>(`/tasks/${id}`),

  cancelTask: (id: string) => request<{ ok: boolean }>(`/tasks/${id}/cancel`, { method: "POST" }),

  uploadLocalImage(filePath: string): Promise<{ url: string; assetId: string }> {
    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: joinUrl(getApiBase(), "/api/uploads"),
        filePath,
        name: "file",
        header: { "X-Lot-Client": "miniprogram", ...authHeader() },
        success(res) {
          if (res.statusCode === 401) {
            clearSession();
            if (!isLoginPage()) wx.reLaunch({ url: "/pages/login/index" });
            reject(new ApiError("请先登录", 401));
            return;
          }
          let body: { url?: string; assetId?: string; error?: string } = {};
          try {
            body = JSON.parse(res.data) as typeof body;
          } catch {
            reject(new ApiError("上传失败", res.statusCode));
            return;
          }
          if (res.statusCode >= 300 || !body.url) {
            reject(new ApiError(body.error || "上传失败", res.statusCode));
            return;
          }
          resolve({ url: body.url, assetId: body.assetId || "" });
        },
        fail(err) {
          reject(new ApiError(err.errMsg || "上传失败", 0));
        },
      });
    });
  },
};

export function absoluteMedia(path: string | undefined | null): string {
  return mediaUrl(getApiBase(), path);
}
