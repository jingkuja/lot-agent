import type {
  ComicCharacterGenerateRequest, ComicCharacterUpload, ComicGenerationPreviewRequest, ComicGenerationQuote, ComicImageRequest, ComicImageTake,
  ComicKeyframeHistory, ComicVideoHistory, ComicVideoTake, ComicVideoReceipt, ComicFrameSaveRequest,
  ComicEpisodeBudget, ComicEpisodeBudgetInput, ComicVideoCreditPause,
} from "@lot-agent/core/comic-drama";
import { request } from "../../api/client.js";

const root = "/comic-drama";
export type GenerationScope = { resource: "series" | "characters"; id: string };
const post = <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>(root + path, { method: "POST", body: JSON.stringify(body), signal });
const series = (id: string, clipId: string) => `/series/${id}/clips/${clipId}`;
function uploadImage<T>(path: string, file: File, signal: AbortSignal) {
  const extensions: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  const contentType = file.type && file.type !== "application/octet-stream" ? file.type : extensions[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  return request<T>(root + path, { method: "POST", headers: { "Content-Type": contentType || "application/octet-stream" }, body: file, signal });
}
export const comicGenerationApi = {
  episodeBudget: (id: string, body: ComicEpisodeBudgetInput, signal?: AbortSignal) =>
    post<ComicEpisodeBudget>(`/series/${id}/episode-budget`, body, signal),
  creditPauses: (id: string, signal?: AbortSignal) => request<ComicVideoCreditPause[]>(root + `/series/${id}/video-credit-pauses`, { signal }),
  resumeCredits: (takeId: string, override: boolean) =>
    post<{ ok: true }>(`/video-takes/${takeId}/resume-credits`, override ? { continueDespiteLowCredits: true } : {}),
  preview: (scope: GenerationScope, input: ComicCharacterUpload | ComicCharacterGenerateRequest | ComicGenerationPreviewRequest, signal?: AbortSignal) =>
    post<ComicGenerationQuote>(`/${scope.resource}/${scope.id}/generation-preview`, input, signal),
  confirm: (scope: GenerationScope, confirmationId: string) =>
    post<ComicImageRequest>(`/${scope.resource}/${scope.id}/generate`, { confirmationId }),
  status: (id: string, signal?: AbortSignal) => request<ComicImageRequest>(root + `/generation-requests/${id}`, { signal }),
  recover: (id: string) => post<ComicImageRequest>(`/generation-requests/${id}/recover`, {}),
  keyframes: (id: string, clipId: string, signal?: AbortSignal) => request<ComicKeyframeHistory>(root + series(id, clipId) + "/keyframes", { signal }),
  approve: (id: string, clipId: string, keyframeTakeId: string, expectedClipRevision: number, expectedSelectionRevision: number) =>
    post<{ ok: true; selectionRevision: number }>(series(id, clipId) + "/keyframe/confirm",
      { keyframeTakeId, expectedClipRevision, expectedSelectionRevision }),
  selectKeyframe: (id: string, clipId: string, mediaId: string, expectedClipRevision: number, expectedSelectionRevision: number) =>
    post<{ ok: true; selectionRevision: number }>(series(id, clipId) + "/keyframe/select",
      { mediaId, expectedClipRevision, expectedSelectionRevision }),
  uploadKeyframe: (id: string, clipId: string, expectedClipRevision: number, expectedSelectionRevision: number, file: File, signal: AbortSignal) =>
    uploadImage<{ mediaId: string; selectionRevision: number }>(
      series(id, clipId) + `/keyframe/upload?expectedClipRevision=${expectedClipRevision}&expectedSelectionRevision=${expectedSelectionRevision}`,
      file, signal),
  characterTakes: (id: string, signal?: AbortSignal) => request<ComicImageTake[]>(root + `/characters/${id}/generations`, { signal }),
  imageAction: (id: string, action: "cancel" | "release") =>
    post<ComicImageTake>(`/image-takes/${id}/${action}`, action === "release" ? { acknowledgePossibleCharge: true } : {}),
  videos: (id: string, clipId: string, signal?: AbortSignal) => request<ComicVideoTake[]>(root + series(id, clipId) + "/videos", { signal }),
  videoHistory: (filters: URLSearchParams, signal?: AbortSignal) => request<ComicVideoHistory>(root + "/clips?" + filters, { signal }),
  videoTake: (id: string, signal?: AbortSignal) => request<ComicVideoTake>(root + "/video-takes/" + encodeURIComponent(id), { signal }),
  adopt: (id: string, clipId: string, takeId: string, expectedClipRevision: number, expectedSelectionRevision: number) =>
    post<{ ok: true; selectionRevision: number }>(series(id, clipId) + "/video/adopt",
      { takeId, expectedClipRevision, expectedSelectionRevision }),
  videoAction: (id: string, action: "cancel" | "release" | "recover") =>
    post<ComicVideoTake>(`/video-takes/${id}/${action}`, action === "release" ? { acknowledgePossibleCharge: true } : {}),
  receipt: (id: string, signal?: AbortSignal) => request<ComicVideoReceipt>(root + `/video-takes/${id}/receipt`, { signal }),
  saveFrame: (id: string, data: ComicFrameSaveRequest, signal?: AbortSignal) => post<unknown>(`/video-takes/${id}/frame`, data, signal),
};
