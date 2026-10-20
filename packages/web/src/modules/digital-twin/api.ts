import { ApiClientError, getToken, request } from "../../api/client.js";

export interface TwinVoice {
  targetModel: string;
  voiceId: string | null;
  status: "unknown" | "DEPLOYING" | "OK" | "UNDEPLOYED";
}
const path = (id: string) => `/rag/manage/items/${encodeURIComponent(id)}/voice`;
export const twinVoiceApi = {
  get: (id: string, signal?: AbortSignal) => request<{ voice: TwinVoice | null }>(path(id), { signal }),
  enroll: (id: string) => request<{ voice: TwinVoice }>(path(id), { method: "POST" }),
  /** Billed per request; callers must not retry automatically. */
  speak: async (id: string, input: { text: string; instructions?: string }, signal?: AbortSignal) => {
    const response = await fetch(`/api${path(id)}/speech`, {
      method: "POST", signal, body: JSON.stringify(input),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken() ?? ""}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
      throw new ApiClientError(body?.error?.message ?? "配音合成失败，请稍后重试", response.status, body?.error?.code);
    }
    return response.blob();
  },
};
