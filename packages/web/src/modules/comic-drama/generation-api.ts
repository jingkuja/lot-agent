import type {
  ComicCharacterUpload, ComicGenerationPreviewRequest, ComicGenerationQuote, ComicImageRequest, ComicImageTake, ComicKeyframeHistory,
  ComicVideoHistory, ComicVideoTake, ComicVideoReceipt, ComicFrameSaveRequest,
} from "@lot-agent/core/comic-drama";
import { request } from "../../api/client.js";

const root = "/comic-drama";
export type GenerationScope = { resource: "series" | "characters"; id: string };
const post = <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>(root + path, { method: "POST", body: JSON.stringify(body), signal });
const series = (id: string, clipId: string) => `/series/${id}/clips/${clipId}`;
export const comicGenerationApi = {
  preview: (scope: GenerationScope, input: ComicCharacterUpload | ComicGenerationPreviewRequest, signal?: AbortSignal) =>
    post<ComicGenerationQuote>(`/${scope.resource}/${scope.id}/generation-preview`, input, signal),
  confirm: (scope: GenerationScope, confirmationId: string) =>
    post<ComicImageRequest>(`/${scope.resource}/${scope.id}/generate`, { confirmationId }),
  status: (id: string, signal?: AbortSignal) => request<ComicImageRequest>(root + `/generation-requests/${id}`, { signal }),
  recover: (id: string) => post<ComicImageRequest>(`/generation-requests/${id}/recover`, {}),
  keyframes: (id: string, clipId: string, signal?: AbortSignal) => request<ComicKeyframeHistory>(root + series(id, clipId) + "/keyframes", { signal }),
  approve: (id: string, clipId: string, keyframeTakeId: string, expectedClipRevision: number) =>
    post<{ ok: true }>(series(id, clipId) + "/keyframe/confirm", { keyframeTakeId, expectedClipRevision }),
  characterTakes: (id: string, signal?: AbortSignal) => request<ComicImageTake[]>(root + `/characters/${id}/generations`, { signal }),
  imageAction: (id: string, action: "cancel" | "release") =>
    post<ComicImageTake>(`/image-takes/${id}/${action}`, action === "release" ? { acknowledgePossibleCharge: true } : {}),
  videos: (id: string, clipId: string, signal?: AbortSignal) => request<ComicVideoTake[]>(root + series(id, clipId) + "/videos", { signal }),
  videoHistory: (filters: URLSearchParams, signal?: AbortSignal) => request<ComicVideoHistory>(root + "/videos?" + filters, { signal }),
  videoTake: (id: string, signal?: AbortSignal) => request<ComicVideoTake>(root + "/video-takes/" + encodeURIComponent(id), { signal }),
  adopt: (id: string, clipId: string, takeId: string, expectedClipRevision: number) =>
    post<{ ok: true }>(series(id, clipId) + "/video/adopt", { takeId, expectedClipRevision }),
  videoAction: (id: string, action: "cancel" | "release" | "recover") =>
    post<ComicVideoTake>(`/video-takes/${id}/${action}`, action === "release" ? { acknowledgePossibleCharge: true } : {}),
  receipt: (id: string, signal?: AbortSignal) => request<ComicVideoReceipt>(root + `/video-takes/${id}/receipt`, { signal }),
  saveFrame: (id: string, data: ComicFrameSaveRequest, signal?: AbortSignal) => post<unknown>(`/video-takes/${id}/frame`, data, signal),
};
