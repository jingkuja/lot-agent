import { MarketingDraftSchema, type MarketingProject } from "@lot-agent/core/marketing-video";
import { ApiClientError, getToken, request } from "../../api/client.js";
import type { Material } from "./materials.js";

/** A project as the editor reads it; opening a draft also returns its material previews. */
export type Project = MarketingProject & { assets?: Record<string, Material> };
// Persisted drafts and older API responses can predate newly added fields.
// Normalize before storing state or computing the saved/dirty snapshot.
export const normalizeProject = (project: Project): Project => ({ ...project, draft: MarketingDraftSchema.parse(project.draft) });
export async function requestProject(path: string, init?: RequestInit): Promise<Project> {
  return normalizeProject(await request<Project>(path, init));
}
export const json = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
/** A shot's twin narration take for listening; reading it is free. */
export async function narrationAudio(projectId: string, slot: number, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/marketing-videos/${projectId}/narration/${slot}`, { signal, headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiClientError(body?.error ?? "配音加载失败，请重试。", response.status);
  }
  return response.blob();
}
