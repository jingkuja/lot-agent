import { useEffect, useRef } from "react";
import { PresenterDraftSchema, type PresenterProject, type PresenterTake, type PresenterTaskState } from "@lot-agent/core/digital-presenter";
import type { MarketingCaptions } from "@lot-agent/core/marketing-video";
import { ApiClientError, getToken, request } from "../../api/client.js";

export type MaterialSlot = "portrait" | "baseVideo" | "faceReference";
export type Material = { id: string; url: string; name: string; mime: string };
/** A project as the editor reads it; opening a draft also returns its material previews. */
export type Project = PresenterProject & { materials?: Partial<Record<MaterialSlot, Material>> };
export interface Capabilities { composition: boolean; subtitles: boolean; speech: boolean; models: { image: string; video: string } }

// Stored drafts may predate newly added fields; normalize before computing the dirty snapshot.
export const normalizeProject = (project: Project): Project => ({ ...project, draft: PresenterDraftSchema.parse(project.draft) });
const json = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
const base = "/digital-presenters";

export const presenterApi = {
  capabilities: () => request<Capabilities>(`${base}/capabilities`),
  list: (cursor?: string) => request<{ data: Project[]; nextCursor?: string }>(`${base}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  get: async (id: string) => normalizeProject(await request<Project>(`${base}/${id}`)),
  save: async (id: string, version: number, draft: Project["draft"]) => normalizeProject(await request<Project>(`${base}/${id}`, json("PUT", { version, draft }))),
  remove: (id: string) => request<{ ok: true }>(`${base}/${id}`, { method: "DELETE" }),
  status: (id: string) => request<PresenterTaskState>(`${base}/${id}/status`),
  script: (topic: string, durationSec: number, locale: string) => request<{ script: string }>(`${base}/script`, json("POST", { topic, durationSec, locale })),
  review: async (id: string, version: number, locale: string) => normalizeProject(await request<Project>(`${base}/${id}/review`, json("POST", { version, locale }))),
  takes: (id: string) => request<{ version: number; takes: PresenterTake[] }>(`${base}/${id}/speech`),
  synthesize: (id: string, version: number, slots: number[] = []) => request<{ version: number; takes: PresenterTake[]; error: string }>(`${base}/${id}/speech`, json("POST", { version, slots })),
  generate: async (id: string, version: number) => normalizeProject(await request<Project>(`${base}/${id}/generate`, json("POST", { version }))),
  resume: async (id: string) => normalizeProject(await request<Project>(`${base}/${id}/resume`, { method: "POST" })),
  /** Compose the made video again with changed captions; the clips are reused without the model. */
  recompose: async (id: string, version: number, captions: MarketingCaptions | undefined) => normalizeProject(await request<Project>(`${base}/${id}/captions`, json("POST", { version, captions }))),
  release: (id: string) => request<{ released: number }>(`${base}/${id}/unknown-clips/release`, { method: "POST" }),
};

/** A segment's take for listening; reading it is free. */
export async function takeAudio(projectId: string, slot: number, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api${base}/${projectId}/speech/${slot}`, { signal, headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiClientError(body?.error ?? "配音加载失败，请重试。", response.status);
  }
  return response.blob();
}

/** Poll a running video's state. The interval grows while nothing changes; a hidden tab waits. */
export function usePresenterPolling(projectId: string | undefined, active: boolean, onState: (state: PresenterTaskState) => void) {
  const callback = useRef(onState);
  callback.current = onState;
  useEffect(() => {
    if (!active || !projectId) return;
    let stopped = false; let delay = 3000; let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(() => void poll(), ms); };
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const state = await presenterApi.status(projectId);
        if (stopped) return;
        const fingerprint = JSON.stringify([state.status, state.progress, state.stage]);
        delay = fingerprint === last ? Math.min(Math.round(delay * 1.5), 20_000) : 3000;
        last = fingerprint;
        callback.current(state);
      } catch { /* the next poll retries */ }
      schedule(delay);
    };
    const shown = () => { if (document.visibilityState === "visible") schedule(0); };
    document.addEventListener("visibilitychange", shown);
    schedule(1000);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", shown); };
  }, [active, projectId]);
}
