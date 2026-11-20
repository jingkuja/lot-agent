import type {
  ComicCastChange, ComicDramaClip, ComicDramaClipDraft, ComicDramaContent, ComicDramaDetail, ComicDramaEpisodeSummary, ComicDramaListing,
  ComicDramaScriptVersion, ComicDramaSeries, ComicDramaSeriesInput, ComicSeriesCast,
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
  currentSummary: (signal?: AbortSignal) =>
    read<{ seriesId: string | null; summary: ComicDramaEpisodeSummary | null }>(`${root}/current?summary=1`, signal),
  open: (id: string) => write<ComicDramaDetail>(`${root}/current`, "PUT", { seriesId: id }),
  create: (fields: ComicDramaSeriesInput) => write<ComicDramaDetail>(root, "POST", fields),
  derive: (id: string, action: "copy" | "sequel", inheritCastAndStyle = true) =>
    write<ComicDramaDetail>(`${path(id)}/${action}`, "POST", action === "sequel" ? { inheritCastAndStyle } : {}),
  cast: (id: string, signal?: AbortSignal) => read<{ cast: ComicSeriesCast[]; seriesRevision: number }>(`${path(id)}/cast`, signal),
  changeCast: (id: string, expectedRevision: number, change: ComicCastChange) => {
    const root = `${path(id)}/cast`;
    const target = root + "/" + change.characterId;
    if (change.action === "add") return write<ComicDramaContent>(root, "POST", {
      expectedRevision, characterId: change.characterId, outfitId: change.outfitId,
    });
    if (change.action === "outfit") return write<ComicDramaContent>(target, "PATCH", { expectedRevision, outfitId: change.outfitId });
    if (change.action === "sync") return write<ComicDramaContent>(target + "/sync", "POST", { expectedRevision });
    return write<ComicDramaContent>(target, "DELETE", { expectedRevision });
  },
  update: (id: string, fields: ComicDramaSeriesInput, expectedRevision: number) =>
    write<ComicDramaSeries>(path(id), "PATCH", { ...fields, expectedRevision }),
  archive: (id: string, expectedRevision: number) => write<{ ok: true }>(`${path(id)}/archive`, "POST", { expectedRevision }),
  remove: (id: string, expectedRevision: number) => write<{ ok: true }>(path(id), "DELETE", { expectedRevision }),
  scriptHistory: (id: string, signal?: AbortSignal) => read<{ versions: ComicDramaScriptVersion[] }>(`${path(id)}/script`, signal),
  saveScript: (id: string, content: string, expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/script`, "PUT", { content, expectedRevision }),
  addClip: (id: string, expectedRevision: number, opts?: { afterClipId?: string; insertIndex?: number }) =>
    write<ComicDramaContent>(`${path(id)}/clips`, "POST", { expectedRevision, ...opts }),
  saveClip: (id: string, clipId: string, draft: ComicDramaClipDraft, expectedRevision: number) =>
    write<{ clip: ComicDramaClip; seriesRevision: number }>(`${path(id)}/clips/${clipId}`, "PATCH", { draft, expectedRevision }),
  copyClip: (id: string, clipId: string, expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/clips/${clipId}/copy`, "POST", { expectedRevision }),
  removeClip: (id: string, clipId: string, expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/clips/${clipId}`, "DELETE", { expectedRevision }),
  reorder: (id: string, clipIds: string[], expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/clips/order`, "PUT", { clipIds, expectedRevision }),
};
