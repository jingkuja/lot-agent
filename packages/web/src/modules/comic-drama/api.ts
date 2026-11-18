import type {
  ComicDramaClip, ComicDramaClipDraft, ComicDramaContent, ComicDramaDetail, ComicDramaListing, ComicDramaSeries, ComicDramaSeriesInput,
} from "@lot-agent/core/comic-drama";
import { request } from "../../api/client.js";

const root = "/comic-drama/series";
const path = (id: string) => `${root}/${encodeURIComponent(id)}`;
const read = <T>(url: string, signal?: AbortSignal) => request<T>(url, { signal });
const write = <T>(url: string, method: string, body: unknown) => request<T>(url, { method, body: JSON.stringify(body) });

export const comicDramaApi = {
  list: (params: URLSearchParams, signal?: AbortSignal) => read<ComicDramaListing>(`${root}?${params}`, signal),
  get: (id: string, signal?: AbortSignal) => read<ComicDramaDetail>(path(id), signal),
  current: (signal?: AbortSignal) => read<{ seriesId: string | null }>(`${root}/current`, signal),
  open: (id: string) => write<ComicDramaDetail>(`${root}/current`, "PUT", { seriesId: id }),
  create: (fields: ComicDramaSeriesInput) => write<ComicDramaDetail>(root, "POST", fields),
  derive: (id: string, action: "copy" | "sequel") => write<ComicDramaDetail>(`${path(id)}/${action}`, "POST", {}),
  update: (id: string, fields: ComicDramaSeriesInput, expectedRevision: number) =>
    write<ComicDramaSeries>(path(id), "PATCH", { ...fields, expectedRevision }),
  archive: (id: string, expectedRevision: number) => write<{ ok: true }>(`${path(id)}/archive`, "POST", { expectedRevision }),
  remove: (id: string, expectedRevision: number) => write<{ ok: true }>(path(id), "DELETE", { expectedRevision }),
  saveScript: (id: string, content: string, expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/script`, "PUT", { content, expectedRevision }),
  addClip: (id: string, expectedRevision: number) => write<ComicDramaContent>(`${path(id)}/clips`, "POST", { expectedRevision }),
  saveClip: (id: string, clipId: string, draft: ComicDramaClipDraft, expectedRevision: number) =>
    write<{ clip: ComicDramaClip; seriesRevision: number }>(`${path(id)}/clips/${clipId}`, "PATCH", { draft, expectedRevision }),
  copyClip: (id: string, clipId: string, expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/clips/${clipId}/copy`, "POST", { expectedRevision }),
  removeClip: (id: string, clipId: string, expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/clips/${clipId}`, "DELETE", { expectedRevision }),
  reorder: (id: string, clipIds: string[], expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/clips/order`, "PUT", { clipIds, expectedRevision }),
};
