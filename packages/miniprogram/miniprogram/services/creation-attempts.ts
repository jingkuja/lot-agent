import { api, absoluteMedia } from "./api.js";

/** Account-scoped durable snapshots, including requests rejected before a server task exists. */
export interface CreationAttempt {
  id: string;
  owner: string;
  mediaType: "image" | "video";
  title: string;
  draft: Record<string, unknown>;
  conversationId?: string;
  taskId?: string;
  status: "submitting" | "pending" | "unknown" | "failed" | "completed" | "download_failed";
  preview?: string;
  updatedAt: string;
}
function ownerKey() { return `lot:attempts:${getApp().globalData.user?.id || "debug"}`; }
export function listAttempts(owner = ownerKey()): CreationAttempt[] {
  const stored = wx.getStorageSync(owner);
  return Array.isArray(stored) ? stored.filter(x => x && typeof x.id === "string" && x.owner === owner && x.draft && typeof x.draft === "object") : [];
}
export function beginAttempt(mediaType: CreationAttempt["mediaType"], draft: Record<string, unknown>): CreationAttempt {
  const owner = ownerKey();
  const attempt: CreationAttempt = {
    id: `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`, owner, mediaType,
    title: String(draft.publishTitle || draft.mainTitle || draft.topic || draft.prompt || "未命名作品").slice(0, 40),
    draft: JSON.parse(JSON.stringify(draft)), status: "submitting", updatedAt: new Date().toISOString(),
  };
  wx.setStorageSync(owner, [attempt, ...listAttempts(owner)]);
  return attempt;
}
export function updateAttempt(attempt: CreationAttempt, patch: Partial<Pick<CreationAttempt, "conversationId" | "taskId" | "status" | "preview" | "draft">>) {
  Object.assign(attempt, patch, { updatedAt: new Date().toISOString() });
  wx.setStorageSync(attempt.owner, listAttempts(attempt.owner).map(item => item.id === attempt.id ? attempt : item));
}
export function removeAttempt(id: string, owner = ownerKey()) {
  wx.setStorageSync(owner, listAttempts(owner).filter(item => item.id !== id));
}
export function queueRetry(attempt: CreationAttempt) { wx.setStorageSync(`${ownerKey()}:retry`, attempt); }
export function takeRetry(mediaType: CreationAttempt["mediaType"]): CreationAttempt | null {
  const key = `${ownerKey()}:retry`;
  const attempt = wx.getStorageSync(key) as CreationAttempt | undefined;
  if (!attempt || attempt.mediaType !== mediaType || attempt.owner !== ownerKey()) return null;
  wx.setStorageSync(key, null);
  return attempt;
}

/** Reconcile with the server before offering a retry, including late proxy responses. */
export async function refreshAttempt(attempt: CreationAttempt): Promise<void> {
  if (!attempt.conversationId || attempt.status === "completed" || attempt.status === "download_failed") return;
  try {
    if (!attempt.taskId) {
      const conversation = await api.getConversation(attempt.conversationId);
      for (const message of [...conversation.messages].reverse()) {
        let meta = message.metadata;
        try { if (typeof meta === "string") meta = JSON.parse(meta); } catch { continue; }
        const value = meta as { kind?: string; mediaType?: string; taskId?: string; status?: string; assets?: Array<{ url?: string }> } | undefined;
        if (message.role !== "assistant" || value?.kind !== "generation" || value.mediaType !== attempt.mediaType) continue;
        if (value.status === "completed" && value.assets?.[0]?.url) {
          updateAttempt(attempt, { status: "completed", preview: absoluteMedia(value.assets[0].url) }); return;
        }
        if (value.status === "download_failed") { updateAttempt(attempt, { status: "download_failed" }); return; }
        if (value.status === "failed" || value.status === "cancelled") { updateAttempt(attempt, { status: "failed" }); return; }
        if (value.taskId) updateAttempt(attempt, { status: "pending", taskId: value.taskId });
        break;
      }
    }
    if (!attempt.taskId) return;
    const task = await api.getTask(attempt.taskId);
    if (task.status === "failed" || task.status === "cancelled") updateAttempt(attempt, { status: "failed" });
    else if (task.status === "succeeded") {
      const url = task.output?.assets?.[0]?.url;
      updateAttempt(attempt, { status: task.output?.downloadFailed ? "download_failed" : url ? "completed" : "failed", preview: absoluteMedia(url) });
    } else updateAttempt(attempt, { status: "pending" });
  } catch { /* Keep the last known state when querying fails. */ }
}
