import type {
  ComicCastChange, ComicDrama, ComicDramaCastContent, ComicDramaClip, ComicDramaClipDraft, ComicDramaContent,
  ComicDramaCreateInput, ComicDramaCurrentState, ComicDramaDetail, ComicDramaEpisodeCreateInput,
  ComicDramaEpisodeSummary, ComicDramaListing, ComicDramaOption, ComicDramaOutlinePolishInput,
  ComicDramaOutlinePolishResult, ComicDramaScriptGenerateInput, ComicDramaScriptGenerateResult,
  ComicDramaScriptVersion, ComicDramaSeries, ComicDramaSeriesInput, ComicDramaTreeListing, ComicDramaUpdateInput,
  ComicDramaView, ComicScriptImport, ComicSeriesCast,
} from "@lot-agent/core/comic-drama";
import { COMIC_SCRIPT_DOCX } from "@lot-agent/core/comic-drama";
import { request } from "../../api/client.js";

const dramasRoot = "/comic-drama/dramas";
const dramaPath = (id: string) => `${dramasRoot}/${encodeURIComponent(id)}`;
const root = "/comic-drama/series";
const path = (id: string) => `${root}/${encodeURIComponent(id)}`;
const read = <T>(url: string, signal?: AbortSignal) => request<T>(url, { signal });
const write = <T>(url: string, method: string, body: unknown) => request<T>(url, { method, body: JSON.stringify(body) });

export const comicDramaApi = {
  listDramas: (params: URLSearchParams, signal?: AbortSignal) => read<ComicDramaTreeListing>(`${dramasRoot}?${params}`, signal),
  listDramaOptions: (signal?: AbortSignal) => read<ComicDramaOption[]>(`${dramasRoot}/options`, signal),
  currentDrama: (signal?: AbortSignal) => read<ComicDramaCurrentState>(`${dramasRoot}/current`, signal),
  openDrama: (dramaId: string) => write<ComicDramaView>(`${dramasRoot}/current`, "PUT", { dramaId }),
  getDrama: (id: string, signal?: AbortSignal) => read<ComicDramaView>(dramaPath(id), signal),
  createDrama: (fields: ComicDramaCreateInput) =>
    write<{ drama: ComicDrama; detail: ComicDramaDetail | null }>(dramasRoot, "POST", fields),
  updateDrama: (id: string, fields: ComicDramaUpdateInput) => write<ComicDrama>(dramaPath(id), "PATCH", fields),
  saveDramaOutline: (id: string, outline: string, expectedRevision: number) =>
    write<ComicDrama>(`${dramaPath(id)}/outline`, "PUT", { outline, expectedRevision }),
  polishDramaOutline: (id: string, input: ComicDramaOutlinePolishInput, signal?: AbortSignal) =>
    request<ComicDramaOutlinePolishResult>(`${dramaPath(id)}/outline/polish`, {
      method: "POST", body: JSON.stringify(input), signal,
    }),
  saveDramaScript: (id: string, content: string, expectedRevision: number) =>
    write<ComicDrama>(`${dramaPath(id)}/script`, "PUT", { content, expectedRevision }),
  generateDramaScript: (id: string, input: ComicDramaScriptGenerateInput, signal?: AbortSignal) =>
    request<ComicDramaScriptGenerateResult>(`${dramaPath(id)}/script/generate`, {
      method: "POST", body: JSON.stringify(input), signal,
    }),
  importDramaScript: (id: string, file: File, signal?: AbortSignal) => request<ComicScriptImport>(
    `${dramaPath(id)}/import`,
    {
      method: "POST",
      body: file,
      signal,
      headers: { "Content-Type": /\.docx$/i.test(file.name) ? COMIC_SCRIPT_DOCX : "text/plain" },
    },
  ),
  dramaCast: (id: string, signal?: AbortSignal) => read<ComicDramaCastContent>(`${dramaPath(id)}/cast`, signal),
  changeDramaCast: (id: string, expectedRevision: number, change: ComicCastChange) => {
    const base = `${dramaPath(id)}/cast`;
    const target = base + "/" + change.characterId;
    if (change.action === "add") return write<ComicDramaCastContent>(base, "POST", {
      expectedRevision, characterId: change.characterId, outfitId: change.outfitId,
    });
    if (change.action === "outfit") return write<ComicDramaCastContent>(target, "PATCH", { expectedRevision, outfitId: change.outfitId });
    if (change.action === "sync") return write<ComicDramaCastContent>(target + "/sync", "POST", { expectedRevision });
    return write<ComicDramaCastContent>(target, "DELETE", { expectedRevision });
  },
  createEpisode: (dramaId: string, fields: ComicDramaEpisodeCreateInput) =>
    write<ComicDramaDetail>(`${dramaPath(dramaId)}/episodes`, "POST", fields),
  archiveDrama: (id: string, expectedRevision: number) =>
    write<{ ok: true }>(`${dramaPath(id)}/archive`, "POST", { expectedRevision }),
  removeDrama: (id: string, expectedRevision: number) => write<{ ok: true }>(dramaPath(id), "DELETE", { expectedRevision }),
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
  syncEpisodeCastFromDrama: (id: string, expectedRevision: number) =>
    write<ComicDramaContent>(`${path(id)}/cast/sync-drama`, "POST", { expectedRevision }),
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
